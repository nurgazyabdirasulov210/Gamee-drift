// Мультиплеер: все, кто открыл игру, попадают в одну пустыню автоматически.
// Серверов у статического хостинга нет, поэтому машины пересылаются через публичные
// MQTT-брокеры по WebSocket. Подключаемся сразу к нескольким — так игроки видят друг
// друга, даже если один брокер недоступен; повторы отсекаем по номеру пакета.
import * as THREE from 'three';
import { buildCarModel } from './carModel.js';
import { HALF } from './config.js';
import { clamp } from './noise.js';
import { CARS } from './garage.js';

// ?broker=wss://адрес — свой брокер (например, для проверки или закрытой игры)
const CUSTOM = typeof location !== 'undefined' && new URLSearchParams(location.search).get('broker');
const BROKERS = CUSTOM && /^wss?:\/\//.test(CUSTOM) ? [CUSTOM] : [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const PREFIX = 'dunedrift/v1/';
const MAX_REMOTES = 24;
const TIMEOUT = 7;            // с без пакетов — игрок ушёл
const SEND_MOVING = 0.1;      // 10 пакетов/с в движении
const SEND_IDLE = 1.0;        // 1 пакет/с, когда стоим или в меню
const PACKET = 70;            // байт без имени
const CIRCLES = [-1.45, 0, 1.45], CR = 1.0;

const enc = new TextEncoder(), dec = new TextDecoder();

// ---------- минимальный клиент MQTT 3.1.1 поверх WebSocket (QoS 0) ----------
function mqttStr(s) {
  const b = typeof s === 'string' ? enc.encode(s) : s;
  const o = new Uint8Array(2 + b.length);
  o[0] = b.length >> 8; o[1] = b.length & 255; o.set(b, 2);
  return o;
}
function packet(type, ...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const hdr = [type];
  let x = len;
  do { let d = x & 127; x >>= 7; if (x > 0) d |= 128; hdr.push(d); } while (x > 0);
  const o = new Uint8Array(hdr.length + len);
  o.set(hdr, 0);
  let off = hdr.length;
  for (const p of parts) { o.set(p, off); off += p.length; }
  return o;
}

class MqttWs {
  constructor(url, clientId, willTopic, onMessage, onChange) {
    this.url = url;
    this.clientId = clientId;
    this.willTopic = willTopic;
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.subs = [];
    this.ready = false;
    this.buf = new Uint8Array(4096);
    this.len = 0;
    this.retry = 2;
    this.stopped = true;
    this.pid = 1;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._rt);
    clearInterval(this._ping);
    if (this.ws) {
      try { if (this.ready) this.ws.send(new Uint8Array([0xe0, 0])); } catch (e) { /* закрыт */ }
      try { this.ws.close(); } catch (e) { /* закрыт */ }
    }
    this.ws = null;
    this._setReady(false);
  }

  _setReady(v) {
    if (this.ready === v) return;
    this.ready = v;
    this.onChange?.();
  }

  _open() {
    let ws;
    try { ws = new WebSocket(this.url, 'mqtt'); } catch (e) { this._later(); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.len = 0;
    const guard = setTimeout(() => { if (!this.ready) try { ws.close(); } catch (e) { /* */ } }, 8000);
    ws.onopen = () => {
      // CONNECT: clean session + «завещание» (пустой пакет = игрок вышел)
      const vh = new Uint8Array([0, 4, 77, 81, 84, 84, 4, 0x06, 0, 30]);
      ws.send(packet(0x10, vh, mqttStr(this.clientId), mqttStr(this.willTopic), mqttStr(new Uint8Array(0))));
    };
    ws.onmessage = (e) => this._data(new Uint8Array(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(guard);
      clearInterval(this._ping);
      if (this.ws === ws) this.ws = null;
      this._setReady(false);
      this._later();
    };
  }

  _later() {
    if (this.stopped) return;
    clearTimeout(this._rt);
    this._rt = setTimeout(() => { if (!this.stopped) this._open(); }, this.retry * 1000);
    this.retry = Math.min(30, this.retry * 1.6);
  }

  _data(chunk) {
    if (this.len + chunk.length > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    let off = 0;
    const b = this.buf;
    while (this.len - off >= 2) {
      let mul = 1, rem = 0, i = off + 1, ok = false;
      for (let k = 0; k < 4 && i < this.len; k++, i++) {
        rem += (b[i] & 127) * mul;
        mul *= 128;
        if ((b[i] & 128) === 0) { ok = true; i++; break; }
      }
      if (!ok || i + rem > this.len) break;
      this._packet(b[off], b.subarray(i, i + rem));
      off = i + rem;
    }
    if (off > 0) { b.copyWithin(0, off, this.len); this.len -= off; }
  }

  _packet(h, body) {
    const type = h >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { try { this.ws.close(); } catch (e) { /* */ } return; }
      this.retry = 2;
      this._setReady(true);
      for (const s of this.subs) this._sendSub(s);
      clearInterval(this._ping);
      this._ping = setInterval(() => { try { this.ws?.send(new Uint8Array([0xc0, 0])); } catch (e) { /* */ } }, 15000);
    } else if (type === 3) { // PUBLISH
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      const qos = (h >> 1) & 3;
      const start = 2 + tl + (qos ? 2 : 0);
      this.onMessage(topic, body.subarray(start));
    }
  }

  _sendSub(filter) {
    const id = this.pid = (this.pid % 65535) + 1;
    this.ws.send(packet(0x82, new Uint8Array([id >> 8, id & 255]), mqttStr(filter), new Uint8Array([0])));
  }

  subscribe(filter) {
    this.subs.push(filter);
    if (this.ready) this._sendSub(filter);
  }

  publish(topic, payload) {
    if (!this.ready || !this.ws || this.ws.bufferedAmount > 64 * 1024) return;
    try { this.ws.send(packet(0x30, mqttStr(topic), payload)); } catch (e) { /* */ }
  }
}

// ---------- чужая машина ----------
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();

function nameTag(name, paint) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px system-ui, sans-serif';
  const w = Math.min(236, g.measureText(name).width + 44);
  const x0 = (256 - w) / 2;
  g.fillStyle = 'rgba(10,8,6,0.55)';
  g.beginPath(); g.roundRect(x0, 10, w, 44, 22); g.fill();
  g.fillStyle = '#' + paint.toString(16).padStart(6, '0');
  g.beginPath(); g.arc(x0 + 20, 32, 8, 0, 7); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(name, x0 + 34, 33, w - 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.renderOrder = 10;
  return s;
}

class Remote {
  constructor(id, slot, paint) {
    this.id = id;
    this.slot = slot;
    this.model = buildCarModel(paint, 'pickup');
    this.mesh = new THREE.Group();
    this.mesh.add(this.model.root);
    this.paint = paint;
    this.name = '';
    this.tag = null;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.tPos = new THREE.Vector3();
    this.tQuat = new THREE.Quaternion();
    this.heading = 0; this.steer = 0; this.slide = 0; this.pitch = 0; this.roll = 0;
    this.speed = 0; this.grounded = true; this.braking = false; this.boosting = false;
    this.seq = -1;
    this.last = 0;     // время последнего пакета
    this.fresh = true;
    this.spinF = 0; this.spinR = 0;
    this.hudColor = '#' + paint.toString(16).padStart(6, '0');
  }

  setCar(i) {
    if (i === this.carIdx) return;
    this.carIdx = i;
    const kind = CARS[i]?.kind || 'pickup';
    if (kind !== this.model.kind) {
      const old = this.model, glow = old.headMat.emissiveIntensity;
      this.mesh.remove(old.root);
      old.paint.dispose(); old.headMat.dispose(); old.tailMat.dispose();
      this.model = buildCarModel(this.paint, kind);
      this.model.headMat.emissiveIntensity = glow;
      this.mesh.add(this.model.root);
    }
    this.mesh.scale.setScalar(CARS[i]?.scale || 1);
  }

  setName(name) {
    if (name === this.name) return;
    this.name = name;
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); this.mesh.remove(this.tag); }
    this.tag = nameTag(name, this.paint);
    this.tag.position.set(0, 2.6, 0);
    this.mesh.add(this.tag);
  }

  setPaint(p) {
    if (p === this.paint) return;
    this.paint = p;
    this.model.paint.color.setHex(p);
    this.hudColor = '#' + p.toString(16).padStart(6, '0');
    const n = this.name; this.name = ''; this.setName(n);
  }

  rearWheels(outA, outB) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    outA.set(this.pos.x - s * 1.4 + c * 0.9, this.pos.y, this.pos.z - c * 1.4 - s * 0.9);
    outB.set(this.pos.x - s * 1.4 - c * 0.9, this.pos.y, this.pos.z - c * 1.4 + s * 0.9);
  }

  // Предсказание по скорости + мягкая подтяжка к последнему пакету: без рывков и без отставания
  update(dt, now, terrain, camPos) {
    const age = Math.min(now - this.last, 0.5);
    _v.copy(this.tPos).addScaledVector(this.vel, age);
    if (this.fresh || this.pos.distanceToSquared(_v) > 144) {
      this.pos.copy(_v);
      this.mesh.quaternion.copy(this.tQuat);
      this.fresh = false;
    } else {
      if (age < 0.5) this.pos.addScaledVector(this.vel, dt);
      this.pos.lerp(_v, 1 - Math.exp(-8 * dt));
      this.mesh.quaternion.slerp(this.tQuat, 1 - Math.exp(-16 * dt));
    }
    if (this.grounded) this.pos.y = terrain.getHeight(this.pos.x, this.pos.z);
    this.mesh.position.copy(this.pos);

    const m = this.model;
    m.body.rotation.set(this.pitch, 0, this.roll);
    const sp = this.speed / 0.42;
    this.spinF += sp * dt;
    this.spinR += sp * (1 + Math.abs(this.slide) * 1.2) * dt;
    for (const w of m.wheels) {
      w.spin.rotation.x = w.front ? this.spinF : this.spinR;
      w.pivot.position.y = m.wheelR - (this.grounded ? 0 : 0.14);
      if (w.front) w.pivot.rotation.y = this.steer;
    }
    m.tailMat.emissiveIntensity = this.braking ? 3.5 : 0.6;

    // табличка с именем: читаемая издалека, не видна совсем далеко
    if (this.tag) {
      const d = camPos.distanceTo(this.pos);
      const k = Math.max(1, d / 22);
      this.tag.scale.set(4 * k, 1 * k, 1);
      this.tag.visible = d < 600;
    }
    this.mesh.updateMatrixWorld(true);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); }
    });
    // геометрии и общие материалы модели кэшируются в carModel.js — свои только эти три
    const m = this.model;
    m.paint.dispose(); m.headMat.dispose(); m.tailMat.dispose();
  }
}

// ---------- сеть ----------
const randId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

export class Net {
  constructor(scene, terrain, effects, { room = 'main', name, paint }) {
    this.scene = scene;
    this.terrain = terrain;
    this.effects = effects;
    this.id = randId();
    this.room = room.replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'main';
    this.base = PREFIX + this.room + '/p/';
    this.name = cleanName(name) || 'Гонщик';
    this.paint = paint;
    this.remotes = new Map();
    this.slots = [];
    this.seq = 0;
    this.sendT = 0;
    this.time = 0;
    this.events = [];
    this.enabled = false;
    this.night = false;
    this.buf = new Uint8Array(PACKET + 48);
    this.dv = new DataView(this.buf.buffer);
    this.links = BROKERS.map((url) => {
      const l = new MqttWs(url, 'dd_' + this.id + '_' + Math.random().toString(36).slice(2, 6),
        this.base + this.id, (t, p) => this._recv(t, p), () => this._status());
      l.subscribe(this.base + '+');
      return l;
    });
    addEventListener('pagehide', () => this._bye());
  }

  get connected() { return this.links.some((l) => l.ready); }
  get count() { return this.remotes.size; }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.links.forEach((l) => l.start());
    else {
      this._bye();
      this.links.forEach((l) => l.stop());
      for (const r of [...this.remotes.values()]) this._drop(r, false);
    }
    this._status();
  }

  setNight(n) {
    this.night = n;
    for (const r of this.remotes.values()) r.model.headMat.emissiveIntensity = n ? 7 : 2.2;
  }

  _status() { this.onStatus?.(); }

  _bye() {
    for (const l of this.links) l.publish(this.base + this.id, new Uint8Array(0));
  }

  _send(car) {
    const d = this.dv, q = car.mesh.quaternion;
    let flags = 0;
    if (car.grounded) flags |= 1;
    if (car.brake > 0.1 || car.handbrake) flags |= 2;
    if (car.boosting) flags |= 4;
    flags |= Math.max(0, CARS.findIndex((c) => c.id === car.spec.id)) << 3;
    this.seq = (this.seq + 1) & 0xffff;
    d.setUint8(0, 1); d.setUint8(1, flags); d.setUint16(2, this.seq, true);
    const f = [car.pos.x, car.pos.y, car.pos.z, q.x, q.y, q.z, q.w, car.vel.x, car.vel.y, car.vel.z,
      car.heading, car.delta || 0, car.driftAngle || 0, car.pitch || 0, car.roll || 0];
    for (let i = 0; i < f.length; i++) d.setFloat32(4 + i * 4, f[i], true);
    d.setUint32(64, this.paint >>> 0, true);
    const nb = enc.encode(this.name).subarray(0, 40);
    d.setUint8(68, nb.length);
    this.buf.set(nb, 69);
    const payload = this.buf.subarray(0, 69 + nb.length);
    for (const l of this.links) l.publish(this.base + this.id, payload);
  }

  _recv(topic, p) {
    if (!topic.startsWith(this.base)) return;
    const id = topic.slice(this.base.length);
    if (id === this.id || !id || id.length > 24) return;
    let r = this.remotes.get(id);
    if (p.length === 0) { if (r) this._drop(r, true); return; }
    if (p.length < 69 || p[0] !== 1) return;
    const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const seq = d.getUint16(2, true);
    if (r && r.seq >= 0) {
      const diff = (seq - r.seq + 0x10000) & 0xffff;
      if (diff === 0 || diff > 0x8000) return; // повтор со второго брокера или старый пакет
    }
    const f = new Array(15);
    for (let i = 0; i < 15; i++) {
      f[i] = d.getFloat32(4 + i * 4, true);
      if (!Number.isFinite(f[i])) return;
    }
    const lim = HALF + 50;
    if (Math.abs(f[0]) > lim || Math.abs(f[2]) > lim || Math.abs(f[1]) > 500) return;
    const nl = Math.min(d.getUint8(68), p.length - 69, 40);
    const name = cleanName(dec.decode(p.subarray(69, 69 + nl))) || 'Гонщик';
    const paint = d.getUint32(64, true) & 0xffffff;

    if (!r) {
      if (this.remotes.size >= MAX_REMOTES) return;
      let slot = 0;
      while (this.slots[slot]) slot++;
      r = new Remote(id, slot, paint);
      this.slots[slot] = r;
      this.remotes.set(id, r);
      r.model.headMat.emissiveIntensity = this.night ? 7 : 2.2;
      this.scene.add(r.mesh);
      if (this.effects) this.effects.botPrev[8 + slot] = null;
      r.setName(name);
      this.events.push({ type: 'join', name });
      this.sendT = 0; // новичок сразу видит и нас

    }
    r.seq = seq;
    r.last = this.time;
    const flags = d.getUint8(1);
    r.setCar(flags >> 3);
    r.grounded = !!(flags & 1); r.braking = !!(flags & 2); r.boosting = !!(flags & 4);
    r.tPos.set(f[0], f[1], f[2]);
    _q.set(f[3], f[4], f[5], f[6]);
    if (_q.lengthSq() > 0.5) r.tQuat.copy(_q.normalize());
    r.vel.set(clamp(f[7], -120, 120), clamp(f[8], -60, 60), clamp(f[9], -120, 120));
    r.speed = Math.hypot(r.vel.x, r.vel.z);
    r.heading = f[10];
    r.steer = clamp(f[11], -0.8, 0.8);
    r.slide = clamp(f[12], -3.2, 3.2);
    r.pitch = clamp(f[13], -0.4, 0.4);
    r.roll = clamp(f[14], -0.4, 0.4);
    r.setPaint(paint);
    r.setName(name);
  }

  _drop(r, announce) {
    this.remotes.delete(r.id);
    this.slots[r.slot] = null;
    r.dispose(this.scene);
    if (announce) this.events.push({ type: 'leave', name: r.name });
  }

  // paused — в меню: шлём редко, машину не двигаем
  update(dt, car, camPos, paused = false) {
    this.time += dt;
    if (!this.enabled) return;
    this.sendT -= dt;
    const moving = !paused && (car.speed > 0.4 || !car.grounded);
    if (this.sendT <= 0 && this.connected) {
      this._send(car);
      this.sendT = moving ? SEND_MOVING : SEND_IDLE;
    } else if (moving && this.sendT > SEND_MOVING) this.sendT = 0; // тронулись — сразу сообщаем
    for (const r of this.remotes.values()) {
      if (this.time - r.last > TIMEOUT) { this._drop(r, true); continue; }
      r.update(dt, this.time, this.terrain, camPos);
      if (!paused && this.effects && r.pos.distanceToSquared(car.pos) < 250 * 250) {
        this.effects.bot(r, dt, 8 + r.slot);
        if (r.boosting) this.effects._flame(r, Math.sin(r.heading), Math.cos(r.heading), dt, 128 + (r.slot % 40) * 3);
      }
    }
  }

  // Столкновение с чужими машинами: каждый игрок отталкивает только себя — у всех одинаково
  collide(car) {
    const sa = Math.sin(car.heading), ca = Math.cos(car.heading);
    for (const r of this.remotes.values()) {
      const dx0 = car.pos.x - r.pos.x, dz0 = car.pos.z - r.pos.z;
      if (dx0 * dx0 + dz0 * dz0 > 49 || Math.abs(car.pos.y - r.pos.y) > 1.8) continue;
      const sb = Math.sin(r.heading), cb = Math.cos(r.heading);
      const R = CR * 2;
      let pen = 0, nx = 0, nz = 0, cx = 0, cz = 0;
      for (let i = 0; i < 3; i++) {
        const ax = r.pos.x + sb * CIRCLES[i], az = r.pos.z + cb * CIRCLES[i];
        for (let j = 0; j < 3; j++) {
          const ddx = car.pos.x + sa * CIRCLES[j] - ax, ddz = car.pos.z + ca * CIRCLES[j] - az;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= R * R) continue;
          const dd = Math.sqrt(d2);
          if (R - dd <= pen) continue;
          pen = R - dd;
          if (dd > 1e-4) { nx = ddx / dd; nz = ddz / dd; } else { nx = cb; nz = -sb; }
          cx = ax + nx * CR; cz = az + nz * CR;
        }
      }
      if (pen <= 0) continue;
      car.pos.x += nx * pen * 0.6; car.pos.z += nz * pen * 0.6;
      const rel = (car.vel.x - r.vel.x) * nx + (car.vel.z - r.vel.z) * nz;
      if (rel >= 0) continue;
      const J = -rel * 0.65;
      car.vel.x += nx * J; car.vel.z += nz * J;
      const rx = cx - car.pos.x, rz = cz - car.pos.z;
      const rf = rx * sa + rz * ca, rl = rx * ca - rz * sa;
      const dvf = (nx * sa + nz * ca) * J, dvl = (nx * ca - nz * sa) * J;
      car.yawRate += clamp((rf * dvl - rl * dvf) * 0.25, -0.7, 0.7);
      if (J > 1.5) car.events.push({ type: 'hit', strength: J, x: cx, z: cz });
    }
  }
}
