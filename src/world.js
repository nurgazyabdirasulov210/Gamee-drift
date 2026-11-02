// Наполнение открытого мира: лагерь, ветряки, трейлеры, контейнеры, ЛЭП, скалы,
// сухие деревья, кусты, заборы (разрушаемые), бочки, покрышки, перекати-поле, трамплины.
import * as THREE from 'three';
import { selectedMap } from './garage.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp } from './noise.js';
import { HALF, QUALITY, WIND } from './config.js';
import { buildExtras } from './worldExtras.js';
import { planksTexture, corrugatedTexture, shrubTexture, bannerTexture, stripesTexture } from './textures.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Цилиндр между двумя точками (для ферм, веток, опор)
function cylBetween(p0, p1, r0, r1 = r0, seg = 6) {
  const dir = _v.subVectors(p1, p0);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(UP, dir.normalize());
  g.applyQuaternion(_q);
  g.translate(p0.x, p0.y, p0.z);
  return g;
}
function boxAt(w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}
function strip(g) {
  // оставить только position/normal/uv, чтобы merge не падал
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  return g.index ? g.toNonIndexed() : g;
}
function merge(list) {
  return mergeGeometries(list.map(strip), false);
}

class SpatialHash {
  constructor(cell = 24) { this.cell = cell; this.map = new Map(); this.stamp = 0; }
  _k(i, j) { return (i + 2048) * 4096 + (j + 2048); }
  insert(o, x, z, r) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const k = this._k(i, j);
        let a = this.map.get(k);
        if (!a) this.map.set(k, (a = []));
        a.push(o);
      }
  }
  query(x, z, r, out) {
    out.length = 0;
    this.stamp++;
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const a = this.map.get(this._k(i, j));
        if (!a) continue;
        for (const o of a) if (o._s !== this.stamp) { o._s = this.stamp; out.push(o); }
      }
    return out;
  }
}

const BIO = selectedMap().biome || {};

export class World {
  constructor(scene, terrain, track, noise) {
    this.scene = scene;
    this.terrain = terrain;
    this.track = track;
    this.noise = noise;
    this.rnd = mulberry32(4242);
    this.colliders = new SpatialHash(24);
    this.occupied = [];
    this.dynamic = [];
    this.flying = new Set();
    this.events = [];
    this.windmills = [];
    this.extraShrubs = [];
    this.blinkers = [];
    this.waters = [];
    this.time = 0;
    this._tmp = [];

    this.mats = {
      metal: new THREE.MeshStandardMaterial({ color: 0x8a8780, metalness: 0.7, roughness: 0.55 }),
      alu: new THREE.MeshStandardMaterial({ color: 0xdfe3e7, metalness: 1.0, roughness: 0.22 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x23272b, metalness: 0.3, roughness: 0.6 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x1b2a33, metalness: 0.4, roughness: 0.08 }),
      wood: new THREE.MeshStandardMaterial({ map: planksTexture(3), roughness: 0.9 }),
      woodDark: new THREE.MeshStandardMaterial({ map: planksTexture(7, [96, 74, 56]), roughness: 0.92 }),
      pole: new THREE.MeshStandardMaterial({ color: 0x5e4a38, roughness: 0.95 }),
      tree: new THREE.MeshStandardMaterial({ color: 0x6f5d4c, roughness: 1.0 }),
      rock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
      roofTin: new THREE.MeshStandardMaterial({ map: corrugatedTexture(11, [150, 140, 130], 0.9), metalness: 0.6, roughness: 0.5 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.95 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf0eee8, roughness: 0.6 }),
      red: new THREE.MeshStandardMaterial({ color: 0xc8382c, roughness: 0.6 }),
      water: new THREE.MeshStandardMaterial({ color: 0x23404a, metalness: 0.2, roughness: 0.05 }),
    };

    this.buildCamp();
    buildExtras(this);
    this.buildOutposts();
    this.buildPowerLine(new THREE.Vector2(-HALF + 60, -260), new THREE.Vector2(HALF - 60, 330));
    this.buildPowerLine(new THREE.Vector2(-180, HALF - 60), new THREE.Vector2(120, -HALF + 60));
    this.buildRamps();
    this.buildTrackDecor();
    this.buildLongFences();
    this.buildRocks();
    this.buildTrees();
    this.buildShrubs();
    this.buildTumbleweeds();
    this.finalizeDynamic();
  }

  // ---------- Утилиты размещения ----------
  h(x, z) { return this.terrain.getHeight(x, z); }
  isFree(x, z, r, trackClear = 6) {
    if (Math.abs(x) > HALF - 40 || Math.abs(z) > HALF - 40) return false;
    if (this.terrain.trackDistanceAt(x, z) < this.track.width / 2 + trackClear + r) return false;
    for (const o of this.occupied) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + r) ** 2) return false;
    return true;
  }
  occupy(x, z, r) { this.occupied.push({ x, z, r }); }

  // Инстансы разбиваются на тайлы ~200 м: невидимые камерой (и вне теневой камеры) не рисуются
  // items: [{ m: Matrix4, color?: Color, obj?: динамический объект }]
  addChunked(geo, mat, items, { cast = true, receive = true, tile = 200, dynamic = false } = {}) {
    const groups = new Map();
    for (const it of items) {
      const e = it.m.elements;
      const k = Math.floor(e[12] / tile) + ',' + Math.floor(e[14] / tile);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(it);
    }
    const meshes = [];
    for (const list of groups.values()) {
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      if (dynamic) inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      list.forEach((it, i) => {
        inst.setMatrixAt(i, it.m);
        if (it.color) inst.setColorAt(i, it.color);
        if (it.obj) { it.obj.mesh = inst; it.obj.idx = i; }
      });
      inst.castShadow = cast;
      inst.receiveShadow = receive;
      inst.computeBoundingSphere();
      this.scene.add(inst);
      meshes.push(inst);
    }
    return meshes;
  }
  // top — высота препятствия над землёй; хранится как мировая Y верхушки
  addCircle(x, z, r, top) {
    const o = { kind: 'c', x, z, r, top: this.h(x, z) + top };
    this.colliders.insert(o, x, z, r);
    return o;
  }
  addBox(x, z, hx, hz, angle, top) {
    const o = { kind: 'b', x, z, hx, hz, c: Math.cos(angle), s: Math.sin(angle), top: this.h(x, z) + top };
    this.colliders.insert(o, x, z, Math.hypot(hx, hz));
    return o;
  }
  place(obj, x, z, ry = 0, sink = 0) {
    obj.position.set(x, this.h(x, z) - sink, z);
    obj.rotation.y = ry;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(obj);
    return obj;
  }

  // ---------- Строения ----------
  makeWindmill() {
    const g = new THREE.Group();
    const parts = [];
    const H = 11, legs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const bot = 1.3, top = 0.28;
    const at = (sx, sz, t) => new THREE.Vector3(sx * (bot + (top - bot) * t), H * t, sz * (bot + (top - bot) * t));
    for (const [sx, sz] of legs) parts.push(cylBetween(at(sx, sz, 0), at(sx, sz, 1), 0.07, 0.05, 5));
    for (let l = 0; l < 5; l++) {
      const t0 = l / 5, t1 = (l + 1) / 5;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = legs[[0, 1, 3, 2][k]], [bx, bz] = legs[[0, 1, 3, 2][(k + 1) % 4]];
        parts.push(cylBetween(at(ax, az, t1), at(bx, bz, t1), 0.03, 0.03, 4));
        parts.push(cylBetween(at(ax, az, t0), at(bx, bz, t1), 0.022, 0.022, 4));
      }
    }
    parts.push(boxAt(1.0, 0.08, 1.0, 0, H, 0));
    const tower = new THREE.Mesh(merge(parts), this.mats.metal);
    g.add(tower);

    const head = new THREE.Group();
    head.position.y = H + 0.6;
    const hp = [];
    hp.push(cylBetween(new THREE.Vector3(0, -0.6, 0), new THREE.Vector3(0, 0, 0), 0.1, 0.1, 8));
    hp.push(boxAt(0.25, 0.3, 0.8, 0, 0, 0.1));
    hp.push(boxAt(0.05, 0.05, 2.4, 0, 0, -1.3));
    hp.push(boxAt(0.04, 1.2, 1.6, 0, 0.1, -2.6));
    head.add(new THREE.Mesh(merge(hp), this.mats.metal));
    const fan = new THREE.Group();
    fan.position.z = 0.55;
    const fp = [];
    const N = 18;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const bl = new THREE.BoxGeometry(0.34, 1.35, 0.02);
      bl.rotateY(0.35);
      bl.translate(0, 0.45 + 0.68, 0);
      bl.rotateZ(a);
      fp.push(bl);
    }
    const ring = new THREE.TorusGeometry(1.75, 0.03, 4, 36);
    fp.push(ring);
    fp.push(new THREE.TorusGeometry(0.5, 0.03, 4, 24));
    fan.add(new THREE.Mesh(merge(fp), this.mats.alu));
    head.add(fan);
    head.rotation.y = Math.atan2(-WIND.x, -WIND.z) + (this.rnd() - 0.5) * 0.4;
    g.add(head);
    this.windmills.push({ fan, speed: 1.6 + this.rnd() * 1.4 });
    return g;
  }

  makeTrailer() {
    const g = new THREE.Group();
    const bodyG = new THREE.CapsuleGeometry(1.25, 4.3, 8, 20);
    bodyG.rotateZ(Math.PI / 2);
    bodyG.scale(1, 1.02, 0.98);
    const body = new THREE.Mesh(bodyG, this.mats.alu);
    body.position.y = 1.85;
    g.add(body);
    const p = [];
    for (const sz of [-1, 1]) {
      p.push(boxAt(3.2, 0.45, 0.06, 0.2, 2.15, sz * 1.21));
      p.push(boxAt(0.9, 0.45, 0.06, -2.4, 2.1, sz * 1.15, 0, 0, 0));
    }
    p.push(boxAt(0.6, 1.4, 0.06, 1.6, 1.55, 1.22));
    g.add(new THREE.Mesh(merge(p), this.mats.glass));
    const d = [];
    d.push(boxAt(5.6, 0.25, 2.1, 0, 0.62, 0));
    d.push(boxAt(1.6, 0.12, 0.12, 4.0, 0.6, 0));
    for (const sz of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.38, 0.38, 0.25, 14);
      w.rotateX(Math.PI / 2);
      w.translate(-0.4, 0.38, sz * 1.05);
      d.push(w);
    }
    d.push(boxAt(0.6, 0.15, 0.5, 1.6, 0.25, 1.5));
    g.add(new THREE.Mesh(merge(d), this.mats.dark));
    return g;
  }

  makeContainer(rgb, seed) {
    const g = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ map: corrugatedTexture(seed, rgb, 0.6), metalness: 0.45, roughness: 0.6 });
    m.map.repeat.set(2, 1);
    const b = new THREE.Mesh(new THREE.BoxGeometry(6.06, 2.6, 2.44), m);
    b.position.y = 1.3;
    g.add(b);
    const fr = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) fr.push(boxAt(0.12, 2.62, 0.12, sx * 3.0, 1.3, sz * 1.19));
    for (let i = 0; i < 4; i++) fr.push(boxAt(0.05, 2.3, 0.05, 3.04, 1.3, -0.9 + i * 0.6));
    g.add(new THREE.Mesh(merge(fr), this.mats.dark));
    return g;
  }

  makeShack() {
    const g = new THREE.Group();
    const walls = new THREE.Mesh(new THREE.BoxGeometry(5, 2.8, 4), this.mats.wood);
    walls.position.y = 1.4;
    g.add(walls);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.1, 4.9), this.mats.roofTin);
    roof.position.set(0, 3.05, 0);
    roof.rotation.x = 0.16;
    g.add(roof);
    const d = [];
    d.push(boxAt(1.0, 2.0, 0.08, -1.2, 1.0, 2.02));
    d.push(boxAt(1.1, 0.8, 0.08, 1.2, 1.7, 2.02));
    d.push(boxAt(0.08, 0.8, 1.1, 2.52, 1.7, 0));
    g.add(new THREE.Mesh(merge(d), this.mats.woodDark));
    // крыльцо и столбики
    const pr = [];
    pr.push(boxAt(5, 0.12, 1.4, 0, 0.2, 2.7));
    for (const sx of [-2.3, 2.3]) pr.push(boxAt(0.12, 2.6, 0.12, sx, 1.5, 3.3));
    g.add(new THREE.Mesh(merge(pr), this.mats.wood));
    return g;
  }

  makeWaterTower() {
    const g = new THREE.Group();
    const p = [];
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      p.push(cylBetween(new THREE.Vector3(sx * 1.6, 0, sz * 1.6), new THREE.Vector3(sx * 1.1, 6, sz * 1.1), 0.14, 0.12, 6));
    }
    p.push(boxAt(3.2, 0.2, 3.2, 0, 6, 0));
    g.add(new THREE.Mesh(merge(p), this.mats.pole));
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 3.2, 20), this.mats.woodDark);
    tank.position.y = 7.7;
    g.add(tank);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 1.2, 20), this.mats.roofTin);
    roof.position.y = 9.9;
    g.add(roof);
    const bands = [];
    for (let i = 0; i < 3; i++) {
      const t = new THREE.TorusGeometry(1.93, 0.04, 4, 32);
      t.rotateX(Math.PI / 2);
      t.translate(0, 6.6 + i * 1.1, 0);
      bands.push(t);
    }
    g.add(new THREE.Mesh(merge(bands), this.mats.dark));
    return g;
  }

  makeFuelTank() {
    const g = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CapsuleGeometry(1.2, 5.0, 6, 20), this.mats.alu);
    t.rotation.z = Math.PI / 2;
    t.position.y = 2.0;
    g.add(t);
    const s = [];
    for (const x of [-2, 0, 2]) s.push(boxAt(0.25, 1.0, 2.0, x, 0.5, 0));
    s.push(cylBetween(new THREE.Vector3(0, 3.1, 0), new THREE.Vector3(0, 3.5, 0), 0.3, 0.3, 10));
    g.add(new THREE.Mesh(merge(s), this.mats.dark));
    return g;
  }

  makeTrough() {
    const g = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.7, 24, 1, true), this.mats.metal);
    t.position.y = 0.35;
    g.add(t);
    const w = new THREE.Mesh(new THREE.CircleGeometry(1.58, 24), this.mats.water);
    w.rotation.x = -Math.PI / 2;
    w.position.y = 0.55;
    g.add(w);
    return g;
  }

  // ---------- Лагерь в центре ----------
  buildCamp() {
    const add = (obj, x, z, ry, coll) => {
      this.place(obj, x, z, ry);
      if (coll) coll(x, z, ry);
    };
    add(this.makeTrailer(), 20, 14, 0.35, (x, z, r) => this.addBox(x, z, 3.4, 1.3, r, 3.2));
    add(this.makeTrailer(), -24, 22, -0.7, (x, z, r) => this.addBox(x, z, 3.4, 1.3, r, 3.2));
    add(this.makeContainer([60, 118, 128], 21), 30, -20, 1.2, (x, z, r) => this.addBox(x, z, 3.05, 1.25, r, 2.7));
    add(this.makeContainer([168, 70, 45], 22), -32, -22, 0.4, (x, z, r) => this.addBox(x, z, 3.05, 1.25, r, 2.7));
    add(this.makeContainer([200, 160, 80], 23), -35.5, -15, 0.45, (x, z, r) => this.addBox(x, z, 3.05, 1.25, r, 2.7));
    add(this.makeShack(), -8, 38, 0.1, (x, z, r) => this.addBox(x, z, 2.6, 2.2, r, 3.2));
    add(this.makeWindmill(), 12, 44, 0, (x, z) => this.addCircle(x, z, 1.4, 12));
    add(this.makeTrough(), 16, 40, 0, (x, z) => this.addCircle(x, z, 1.6, 0.8));
    add(this.makeWaterTower(), -42, 4, 0.3, (x, z) => this.addCircle(x, z, 2.0, 10));
    add(this.makeFuelTank(), 42, 10, 1.4, (x, z, r) => this.addBox(x, z, 3.6, 1.3, r, 3.3));
    this.occupy(0, 0, 60);

    // Бочки
    for (const [cx, cz, n] of [[26, 2, 7], [-16, -8, 5], [-38, 12, 6], [6, 30, 4]]) {
      for (let i = 0; i < n; i++) {
        const a = this.rnd() * 6.28, r = this.rnd() * 2.2;
        this.addDynamic('barrel', cx + Math.cos(a) * r, cz + Math.sin(a) * r, this.rnd() * 6.28);
      }
    }
    // Кольцевой забор с проездами
    const R = 64;
    const segs = Math.floor((2 * Math.PI * R) / 3);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      if (Math.abs(Math.sin(a)) > 0.93 || Math.abs(Math.cos(a)) > 0.97) continue; // проезды
      const x = Math.cos(a) * R, z = Math.sin(a) * R;
      this.addDynamic('fence', x, z, -a);
    }
  }

  buildOutposts() {
    const types = ['windmill', 'trailer', 'containers', 'shack', 'tower', 'windmill', 'fuel', 'containers', 'trailer', 'windmill', 'shack'];
    let placed = 0, tries = 0;
    while (placed < types.length && tries < 2000) {
      tries++;
      const a = this.rnd() * Math.PI * 2, r = 160 + this.rnd() * 560;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!this.isFree(x, z, 26, 10)) continue;
      const n = this.terrain.getNormal(x, z);
      if (n.y < 0.93) continue;
      const type = types[placed++];
      const ry = this.rnd() * Math.PI * 2;
      if (type === 'windmill') {
        this.place(this.makeWindmill(), x, z, 0); this.addCircle(x, z, 1.4, 12);
        this.place(this.makeTrough(), x + 4, z + 2, 0); this.addCircle(x + 4, z + 2, 1.6, 0.8);
      } else if (type === 'trailer') {
        this.place(this.makeTrailer(), x, z, ry); this.addBox(x, z, 3.4, 1.3, ry, 3.2);
      } else if (type === 'containers') {
        this.place(this.makeContainer([90 + this.rnd() * 100, 80 + this.rnd() * 60, 60], placed * 7), x, z, ry);
        this.addBox(x, z, 3.05, 1.25, ry, 2.7);
        const x2 = x + Math.sin(ry) * 3.2, z2 = z + Math.cos(ry) * 3.2;
        this.place(this.makeContainer([150, 60, 40], placed * 7 + 3), x2, z2, ry + 0.05);
        this.addBox(x2, z2, 3.05, 1.25, ry + 0.05, 2.7);
      } else if (type === 'shack') {
        this.place(this.makeShack(), x, z, ry); this.addBox(x, z, 2.6, 2.2, ry, 3.2);
      } else if (type === 'tower') {
        this.place(this.makeWaterTower(), x, z, ry); this.addCircle(x, z, 2.0, 10);
      } else if (type === 'fuel') {
        this.place(this.makeFuelTank(), x, z, ry); this.addBox(x, z, 3.6, 1.3, ry, 3.3);
      }
      this.occupy(x, z, 14);
      // Загон из забора вокруг
      if (this.rnd() < 0.75) {
        const R = 13 + this.rnd() * 6;
        const segs = Math.floor((2 * Math.PI * R) / 3);
        const gap = this.rnd() * Math.PI * 2;
        for (let i = 0; i < segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          if (Math.abs(Math.atan2(Math.sin(a - gap), Math.cos(a - gap))) < 0.45) continue;
          this.addDynamic('fence', x + Math.cos(a) * R, z + Math.sin(a) * R, -a);
        }
      }
      for (let i = 0; i < 4; i++) this.addDynamic('barrel', x + (this.rnd() - 0.5) * 8, z + 5 + this.rnd() * 3, 0);
    }
  }

  buildPowerLine(a, b) {
    const dir = new THREE.Vector2().subVectors(b, a);
    const len = dir.length();
    dir.normalize();
    const ang = Math.atan2(dir.x, dir.y);
    const step = 46;
    const poleParts = [];
    poleParts.push(cylBetween(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0, 9, 0), 0.17, 0.13, 7));
    poleParts.push(boxAt(2.6, 0.16, 0.16, 0, 8.4, 0));
    for (const x of [-1.15, 0, 1.15]) {
      if (x !== 0) poleParts.push(cylBetween(new THREE.Vector3(x, 8.48, 0), new THREE.Vector3(x, 8.8, 0), 0.05, 0.04, 6));
    }
    poleParts.push(cylBetween(new THREE.Vector3(0, 9, 0), new THREE.Vector3(0, 9.3, 0), 0.05, 0.04, 6));
    poleParts.push(cylBetween(new THREE.Vector3(-0.9, 7.6, 0), new THREE.Vector3(0, 8.4, 0), 0.05, 0.05, 4));
    poleParts.push(cylBetween(new THREE.Vector3(0.9, 7.6, 0), new THREE.Vector3(0, 8.4, 0), 0.05, 0.05, 4));
    const poleGeo = merge(poleParts);
    const count = Math.floor(len / step) + 1;
    const poles = [];
    const tops = [];
    for (let i = 0; i < count; i++) {
      const x = a.x + dir.x * i * step, z = a.y + dir.y * i * step;
      if (this.terrain.trackDistanceAt(x, z) < this.track.width / 2 + 4) {
        tops.push(null); // перекрёсток с трассой: опору пропускаем
        continue;
      }
      const y = this.h(x, z);
      const lean = (this.rnd() - 0.5) * 0.08;
      _q.setFromEuler(new THREE.Euler(lean, ang, (this.rnd() - 0.5) * 0.06));
      _m.compose(_v.set(x, y, z), _q, _s.set(1, 1, 1));
      poles.push({ m: _m.clone() });
      this.addCircle(x, z, 0.35, 9);
      const pts = [new THREE.Vector3(-1.15, 8.8, 0), new THREE.Vector3(1.15, 8.8, 0), new THREE.Vector3(0, 9.3, 0)]
        .map((p) => p.applyMatrix4(_m));
      tops.push(pts);
    }
    this.addChunked(poleGeo, this.mats.pole, poles, { receive: false });
    // Провода с провисанием
    const verts = [];
    for (let i = 0; i + 1 < tops.length; i++) {
      const A = tops[i], B = tops[i + 1];
      if (!A || !B) continue;
      for (let k = 0; k < 3; k++) {
        const p0 = A[k], p1 = B[k];
        const S = 14;
        for (let s = 0; s < S; s++) {
          const t0 = s / S, t1 = (s + 1) / S;
          const sag = (t) => -4 * 1.4 * t * (1 - t);
          verts.push(
            p0.x + (p1.x - p0.x) * t0, p0.y + (p1.y - p0.y) * t0 + sag(t0), p0.z + (p1.z - p0.z) * t0,
            p0.x + (p1.x - p0.x) * t1, p0.y + (p1.y - p0.y) * t1 + sag(t1), p0.z + (p1.z - p0.z) * t1,
          );
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x2a2520, transparent: true, opacity: 0.8 })));
  }

  // ---------- Трамплины ----------
  makeRampMesh(r) {
    const s = new THREE.Shape();
    s.moveTo(-r.length / 2, 0);
    s.lineTo(r.length / 2, 0);
    s.lineTo(r.length / 2, r.height);
    s.lineTo(-r.length / 2, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: r.width, bevelEnabled: false });
    g.rotateY(-Math.PI / 2);
    g.translate(r.width / 2, 0, 0);
    g.computeVertexNormals();
    const mat = this.mats.wood;
    const grp = new THREE.Group();
    const m = new THREE.Mesh(g, mat);
    grp.add(m);
    // опоры и полосы
    const p = [];
    for (const sx of [-1, 1]) {
      p.push(boxAt(0.18, r.height + 0.4, 0.18, sx * (r.width / 2 - 0.1), (r.height - 0.4) / 2, r.length / 2 - 0.1));
      p.push(boxAt(0.18, r.height / 2 + 0.4, 0.18, sx * (r.width / 2 - 0.1), r.height / 4 - 0.2, 0));
    }
    grp.add(new THREE.Mesh(merge(p), this.mats.woodDark));
    const stripeMat = new THREE.MeshStandardMaterial({ map: stripesTexture('#e0a21b', '#1d1d1d', 8), roughness: 0.6 });
    const edge = new THREE.Mesh(new THREE.BoxGeometry(r.width + 0.02, 0.12, 0.3), stripeMat);
    edge.position.set(0, r.height - 0.03, r.length / 2 - 0.15);
    grp.add(edge);
    grp.position.set(r.x, r.base, r.z);
    grp.rotation.y = r.angle;
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(grp);
  }

  buildRamps() {
    const T = this.terrain;
    const list = [];
    // Трамплин в лагере
    list.push(T.addRamp(0, -40, Math.PI, 9, 6, 2.2));
    // На трассе
    const tr = this.track;
    for (const frac of [0.18, 0.52, 0.81]) {
      const i = Math.floor(tr.count * frac);
      const p = tr.point(i), d = tr.dir(i);
      list.push(T.addRamp(p.x, p.z, Math.atan2(d.x, d.z), 10, 9, 2.0));
    }
    // По миру
    let tries = 0, n = 0;
    while (n < 14 && tries < 3000) {
      tries++;
      const x = (this.rnd() - 0.5) * (2 * HALF - 200), z = (this.rnd() - 0.5) * (2 * HALF - 200);
      if (!this.isFree(x, z, 10, 4)) continue;
      const nn = T.getNormal(x, z);
      if (nn.y < 0.96) continue;
      const big = this.rnd() < 0.3;
      list.push(T.addRamp(x, z, this.rnd() * Math.PI * 2, big ? 13 : 9, big ? 7 : 5.5, big ? 3.6 : 2.4));
      this.occupy(x, z, 12);
      n++;
    }
    for (const r of list) this.makeRampMesh(r);
    this.ramps = list;
  }

  // ---------- Оформление трассы ----------
  buildTrackDecor() {
    const tr = this.track, hw = tr.width / 2;
    // Ворота старт/финиш
    const p0 = tr.point(0), d0 = tr.dir(0);
    const ang = Math.atan2(d0.x, d0.z);
    const gate = new THREE.Group();
    const posts = [];
    for (const sx of [-1, 1]) posts.push(boxAt(0.6, 7, 0.6, sx * (hw + 1), 3.5, 0));
    gate.add(new THREE.Mesh(merge(posts), this.mats.dark));
    const ban = new THREE.Mesh(
      new THREE.BoxGeometry(2 * hw + 2.6, 1.5, 0.25),
      [this.mats.dark, this.mats.dark, this.mats.dark, this.mats.dark,
        new THREE.MeshStandardMaterial({ map: bannerTexture('СТАРТ · ФИНИШ'), roughness: 0.6, emissive: 0x331111 }),
        new THREE.MeshStandardMaterial({ map: bannerTexture('DUNE DRIFT'), roughness: 0.6, emissive: 0x331111 })],
    );
    ban.position.y = 6.6;
    gate.add(ban);
    this.place(gate, p0.x, p0.z, ang);
    this.addCircle(p0.x + Math.cos(ang) * (hw + 1), p0.z - Math.sin(ang) * (hw + 1), 0.5, 7);
    this.addCircle(p0.x - Math.cos(ang) * (hw + 1), p0.z + Math.sin(ang) * (hw + 1), 0.5, 7);

    // Шахматная линия старта
    const chk = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * hw, 2.2),
      new THREE.MeshStandardMaterial({ map: (() => {
        const c = document.createElement('canvas'); c.width = 256; c.height = 32;
        const g = c.getContext('2d');
        for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#eee'; g.fillRect(i * 16, j * 16, 16, 16); }
        const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
      })(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    chk.rotation.x = -Math.PI / 2;
    chk.rotation.z = ang;
    chk.position.set(p0.x, this.h(p0.x, p0.z) + 0.06, p0.z);
    chk.receiveShadow = true;
    this.scene.add(chk);

    // Столбики-вешки по краям
    const markerGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.4, 6);
    markerGeo.translate(0, 0.7, 0);
    const markerMat = new THREE.MeshStandardMaterial({ map: stripesTexture('#d8382b', '#f2efe6', 4), roughness: 0.6 });
    const nM = Math.floor(tr.count / 8) * 2;
    const markers = [];
    for (let i = 0; i < tr.count; i += 8) {
      const p = tr.point(i), d = tr.dir(i);
      for (const sd of [-1, 1]) {
        const x = p.x + d.z * sd * (hw + 1.5), z = p.z - d.x * sd * (hw + 1.5);
        _m.compose(_v.set(x, this.h(x, z), z), _q.identity(), _s.set(1, 1, 1));
        if (markers.length < nM) markers.push({ m: _m.clone() });
      }
    }
    this.addChunked(markerGeo, markerMat, markers, { receive: false });

    // Покрышки на внешней стороне поворотов
    for (let i = 0; i < tr.count; i += 3) {
      const a = tr.dir(i - 6), b = tr.dir(i + 6);
      const cross = a.x * b.z - a.z * b.x;
      if (Math.abs(cross) < 0.16) continue;
      const p = tr.point(i), d = tr.dir(i);
      const side = cross > 0 ? 1 : -1; // внешняя сторона
      const x = p.x + d.z * side * (hw + 3.2), z = p.z - d.x * side * (hw + 3.2);
      this.addDynamic('tires', x, z, this.rnd() * 6.28);
    }
  }

  buildLongFences() {
    for (let f = 0; f < 7; f++) {
      const x = (this.rnd() - 0.5) * 1300, z = (this.rnd() - 0.5) * 1300;
      const a = this.rnd() * Math.PI * 2;
      const len = 90 + this.rnd() * 160;
      const dx = Math.sin(a), dz = Math.cos(a);
      for (let s = 0; s < len; s += 3) {
        const px = x + dx * s, pz = z + dz * s;
        if (Math.abs(px) > HALF - 50 || Math.abs(pz) > HALF - 50) break;
        if (this.terrain.trackDistanceAt(px, pz) < this.track.width / 2 + 2) continue;
        if (Math.hypot(px, pz) < 75) continue;
        let blocked = false;
        for (const o of this.occupied) if ((o.x - px) ** 2 + (o.z - pz) ** 2 < o.r * o.r) { blocked = true; break; }
        if (blocked) continue;
        this.addDynamic('fence', px, pz, a);
      }
    }
  }

  // ---------- Скалы ----------
  makeRockGeo(seed) {
    const n = this.noise;
    let g = new THREE.IcosahedronGeometry(1, 4);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const dark = new THREE.Color(BIO.rockDark ?? 0x8d6a4a), light = new THREE.Color(BIO.rockLight ?? 0xd8b07c), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      const k = 1 + 0.28 * n.noise(_v.x * 1.3 + seed, _v.y * 1.3 + _v.z * 0.7)
        + 0.12 * n.noise(_v.z * 3.1 - seed, _v.x * 3.1 + _v.y)
        + 0.04 * n.noise(_v.x * 8 + _v.z * 3, _v.y * 8 + seed);
      _v.multiplyScalar(k);
      _v.y *= 0.62;
      if (_v.y < -0.25) _v.y = -0.25 + (_v.y + 0.25) * 0.2;
      pos.setXYZ(i, _v.x, _v.y, _v.z);
      const t = clamp((_v.y + 0.3) / 0.9 + 0.15 * n.noise(_v.x * 4, _v.z * 4) + 0.04 * Math.sin(_v.y * 25), 0, 1);
      c.copy(dark).lerp(light, t);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  buildRocks() {
    const variants = 4;
    const geos = [];
    for (let i = 0; i < variants; i++) geos.push(this.makeRockGeo(i * 13.7));
    const items = [];
    // Скальные гряды
    for (let f = 0; f < Math.round(16 * (BIO.rocks ?? 1)); f++) {
      let tries = 0;
      while (tries++ < 50) {
        const x = (this.rnd() - 0.5) * 1400, z = (this.rnd() - 0.5) * 1400;
        if (!this.isFree(x, z, 14, 6)) continue;
        const a = this.rnd() * 6.28;
        const cnt = 5 + Math.floor(this.rnd() * 7);
        for (let i = 0; i < cnt; i++) {
          const t = i - cnt / 2;
          const px = x + Math.sin(a) * t * 3.4 + (this.rnd() - 0.5) * 2;
          const pz = z + Math.cos(a) * t * 3.4 + (this.rnd() - 0.5) * 2;
          items.push({ x: px, z: pz, s: (1.6 + this.rnd() * 2.2) * (BIO.rockBig ?? 1), v: Math.floor(this.rnd() * variants) });
        }
        this.occupy(x, z, cnt * 2);
        break;
      }
    }
    // Россыпь
    for (let i = 0; i < Math.round(420 * (BIO.rocks ?? 1)); i++) {
      const x = (this.rnd() - 0.5) * 1500, z = (this.rnd() - 0.5) * 1500;
      const s = 0.3 + Math.pow(this.rnd(), 2.5) * 2.4;
      if (!this.isFree(x, z, s, 2)) continue;
      items.push({ x, z, s, v: Math.floor(this.rnd() * variants) });
    }
    // Немного камней у лагеря
    for (let i = 0; i < 18; i++) {
      const a = this.rnd() * 6.28, r = 68 + this.rnd() * 30;
      items.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.4 + this.rnd() * 1.4, v: i % variants });
    }
    for (let v = 0; v < variants; v++) {
      const list = items.filter((it) => it.v === v);
      const big = [], small = [];
      for (const it of list) {
        const y = this.h(it.x, it.z) - 0.12 * it.s;
        _q.setFromEuler(new THREE.Euler((this.rnd() - 0.5) * 0.3, this.rnd() * 6.28, (this.rnd() - 0.5) * 0.3));
        const sx = it.s * (0.8 + this.rnd() * 0.5), sz = it.s * (0.8 + this.rnd() * 0.5);
        _m.compose(_v.set(it.x, y, it.z), _q, _s.set(sx, it.s * (0.7 + this.rnd() * 0.5), sz));
        (it.s >= 1 ? big : small).push({ m: _m.clone() });
        if (it.s > 0.9) this.addCircle(it.x, it.z, Math.min(sx, sz) * 0.85, it.s * 0.38);
      }
      // мелкие камни теней почти не дают — не рисуем их в теневой проход
      this.addChunked(geos[v], this.mats.rock, big);
      this.addChunked(geos[v], this.mats.rock, small, { cast: false });
    }
  }

  // ---------- Сухие деревья ----------
  makeTreeGeo(seed) {
    const rnd = mulberry32(seed);
    const parts = [];
    const grow = (p0, dir, len, r, depth) => {
      const p1 = p0.clone().addScaledVector(dir, len);
      parts.push(cylBetween(p0, p1, r, r * 0.65, 5));
      if (depth <= 0) return;
      const nb = depth === 3 ? 3 : 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < nb; i++) {
        const d = dir.clone();
        d.x += (rnd() - 0.5) * 1.6; d.z += (rnd() - 0.5) * 1.6; d.y += 0.15 + rnd() * 0.4;
        d.normalize();
        grow(p1.clone().lerp(p0, rnd() * 0.3), d, len * (0.55 + rnd() * 0.2), r * 0.62, depth - 1);
      }
    };
    grow(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3((rnd() - 0.5) * 0.3, 1, (rnd() - 0.5) * 0.3).normalize(), 2.4 + rnd(), 0.2, 3);
    return merge(parts);
  }

  // Сосна: ствол и ярусы хвои (вершины красим от тёмной зелени к заснеженной)
  makePineGeo(seed) {
    const rnd = mulberry32(seed);
    const parts = [];
    const paint = (g, hex, hex2 = null) => {
      const c1 = new THREE.Color(hex), c2 = new THREE.Color(hex2 ?? hex);
      const p = g.attributes.position, col = new Float32Array(p.count * 3);
      let lo = 1e9, hi = -1e9;
      for (let i = 0; i < p.count; i++) { lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i)); }
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) - lo) / Math.max(hi - lo, 1e-3), c = c1.clone().lerp(c2, t * t);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      return g;
    };
    const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.2, 6);
    trunk.translate(0, 0.8, 0);
    parts.push(paint(strip(trunk), 0x4a3524));
    const tiers = 5 + Math.floor(rnd() * 2);
    for (let i = 0; i < tiers; i++) {
      const k = i / (tiers - 1);
      const r = (2.1 - k * 1.5) * (0.9 + rnd() * 0.2), h = 2.1 - k * 0.5;
      const cone = new THREE.ConeGeometry(r, h, 8, 1);
      cone.translate(0, 1.4 + i * 1.25, 0);
      parts.push(paint(strip(cone), 0x1f4a2e, 0xe9f1f4));
    }
    return mergeGeometries(parts, false);
  }

  buildTrees() {
    const kind = BIO.trees ?? 'dead';
    if (kind === 'none') return;
    const pine = kind === 'pine';
    const variants = 3;
    const mul = BIO.treeMul ?? 1;
    const mat = pine ? (this.mats.pine ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })) : this.mats.tree;
    if (!pine && BIO.treeCol) mat.color.setHex(BIO.treeCol);
    for (let v = 0; v < variants; v++) {
      const geo = pine ? this.makePineGeo(100 + v * 17) : this.makeTreeGeo(100 + v * 17);
      const list = [];
      for (let i = 0; i < Math.round(40 * mul); i++) {
        const x = (this.rnd() - 0.5) * 1480, z = (this.rnd() - 0.5) * 1480;
        if (!this.isFree(x, z, 2, 3)) continue;
        list.push({ x, z, s: 0.8 + this.rnd() * 0.8 });
      }
      if (v === 0) list.push({ x: -50, z: 30, s: 1.3 }, { x: 52, z: -36, s: 1.1 });
      const items = list.map((it) => {
        _q.setFromAxisAngle(UP, this.rnd() * 6.28);
        _m.compose(_v.set(it.x, this.h(it.x, it.z), it.z), _q, _s.set(it.s, it.s, it.s));
        this.addCircle(it.x, it.z, 0.35 * it.s, 4 * it.s);
        return { m: _m.clone() };
      });
      this.addChunked(geo, mat, items, { receive: false });
    }
  }

  // ---------- Кусты (качаются на ветру) ----------
  buildShrubs() {
    const quads = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(1.3, 1);
      g.translate(0, 0.5, 0);
      g.rotateY((i / 3) * Math.PI);
      quads.push(g);
    }
    const geo = mergeGeometries(quads);
    const mat = new THREE.MeshStandardMaterial({
      map: shrubTexture(9), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1,
    });
    this.shrubUniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.shrubUniforms.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
          float sway = sin(uTime * 2.3 + ph) * 0.6 + sin(uTime * 4.1 + ph * 2.0) * 0.3;
          transformed.x += sway * 0.09 * position.y * position.y;
          transformed.z += sway * 0.05 * position.y * position.y;`);
    };
    const extra = this.extraShrubs;
    const N = Math.round(QUALITY.shrubs * (BIO.shrubs ?? 1)) + extra.length;
    const items = [];
    let k = 0;
    for (const e of extra) {
      _q.setFromAxisAngle(UP, this.rnd() * 6.28);
      _m.compose(_v.set(e.x, this.h(e.x, e.z) - 0.05, e.z), _q, _s.set(e.s, e.s * 1.4, e.s));
      items.push({ m: _m.clone(), color: new THREE.Color().setHSL(0.22 + this.rnd() * 0.06, 0.45, 0.45 + this.rnd() * 0.15) });
      k++;
    }
    for (let i = 0; i < N * 1.6 && k < N; i++) {
      // скопления вокруг «оазисов» шума
      const x = (this.rnd() - 0.5) * 1540, z = (this.rnd() - 0.5) * 1540;
      const dens = this.noise.noise(x * 0.006 + 40, z * 0.006 - 40);
      if (dens < -0.15 && this.rnd() < 0.8) continue;
      if (this.terrain.trackDistanceAt(x, z) < this.track.width / 2 + 0.5) continue;
      if (Math.hypot(x, z) < 50) continue;
      const s = 0.45 + this.rnd() * 1.0;
      _q.setFromAxisAngle(UP, this.rnd() * 6.28);
      _m.compose(_v.set(x, this.h(x, z) - 0.05, z), _q, _s.set(s, s * (0.7 + this.rnd() * 0.5), s));
      items.push({ m: _m.clone(), color: BIO.shrubHSL ? new THREE.Color().setHSL(BIO.shrubHSL[0] + this.rnd() * 0.04, BIO.shrubHSL[1], BIO.shrubHSL[2] + this.rnd() * 0.12) : new THREE.Color().setHSL(0.09 + this.rnd() * 0.04, 0.25 + this.rnd() * 0.2, 0.55 + this.rnd() * 0.25) });
      k++;
    }
    this.addChunked(geo, mat, items, { cast: false });
  }

  // ---------- Динамические объекты ----------
  dynGeo(type) {
    if (!this._dynGeos) this._dynGeos = {};
    if (this._dynGeos[type]) return this._dynGeos[type];
    let g, mat, r, baseY;
    if (type === 'fence') {
      const p = [];
      p.push(cylBetween(new THREE.Vector3(0, -0.65, -1.5), new THREE.Vector3(0, 0.65, -1.5), 0.07, 0.06, 5));
      for (const y of [-0.2, 0.15, 0.5]) p.push(boxAt(0.025, 0.025, 3.0, 0, y, 0));
      for (let i = 0; i < 9; i++) p.push(boxAt(0.05, 0.05, 0.05, 0, 0.5, -1.3 + i * 0.32, 0, 0.6, 0.6));
      g = merge(p); mat = this.mats.pole; r = 1.4; baseY = 0.62;
    } else if (type === 'barrel') {
      g = new THREE.CylinderGeometry(0.33, 0.33, 0.9, 14);
      const rings = [];
      for (const y of [-0.28, 0.28]) { const t = new THREE.TorusGeometry(0.335, 0.02, 4, 18); t.rotateX(Math.PI / 2); t.translate(0, y, 0); rings.push(t); }
      g = merge([g, ...rings]);
      mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.5 });
      r = 0.45; baseY = 0.45;
    } else if (type === 'tires') {
      const p = [];
      for (let i = 0; i < 3; i++) { const t = new THREE.TorusGeometry(0.4, 0.15, 6, 12); t.rotateX(Math.PI / 2); t.translate(0, -0.3 + i * 0.3, 0); p.push(t); }
      g = merge(p); mat = this.mats.rubber; r = 0.6; baseY = 0.45;
    } else if (type === 'crate') {
      const p = [new THREE.BoxGeometry(1.0, 1.0, 1.0)];
      for (const y of [-0.42, 0.42]) for (const z of [-0.51, 0.51]) p.push(boxAt(1.04, 0.1, 0.04, 0, y, z));
      g = merge(p); mat = this.mats.wood; r = 0.6; baseY = 0.5;
    } else if (type === 'tumbleweed') {
      const rnd = mulberry32(77);
      const p = [];
      for (let i = 0; i < 46; i++) {
        const a = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(0.55 * (0.6 + rnd() * 0.4));
        const b = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize().multiplyScalar(0.55 * (0.6 + rnd() * 0.4));
        p.push(cylBetween(a, b, 0.012, 0.012, 3));
      }
      g = merge(p);
      mat = new THREE.MeshStandardMaterial({ color: 0xa88a5e, roughness: 1 });
      r = 0.6; baseY = 0.5;
    }
    return (this._dynGeos[type] = { g, mat, r, baseY, list: [] });
  }

  addDynamic(type, x, z, ry) {
    const d = this.dynGeo(type);
    const y = this.h(x, z) + d.baseY;
    const o = {
      type, x, z, r: d.r, baseY: d.baseY,
      pos: new THREE.Vector3(x, y, z),
      quat: new THREE.Quaternion().setFromAxisAngle(UP, ry),
      vel: new THREE.Vector3(), ang: new THREE.Vector3(),
      flying: false, idx: d.list.length, mesh: null, hp: 1,
    };
    d.list.push(o);
    this.dynamic.push(o);
    return o;
  }

  finalizeDynamic() {
    const tint = [new THREE.Color(0xb63a2a), new THREE.Color(0x2f5d8a), new THREE.Color(0x8a6a3a), new THREE.Color(0x3d6b45), new THREE.Color(0xd9d4c8)];
    for (const [type, d] of Object.entries(this._dynGeos)) {
      if (type === 'tumbleweed') {
        // перекати-поле всегда рядом с игроком и постоянно движется — один меш без отсечения
        const inst = new THREE.InstancedMesh(d.g, d.mat, d.list.length);
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        inst.castShadow = true;
        inst.frustumCulled = false;
        d.list.forEach((o, i) => { o.mesh = inst; o.idx = i; _m.compose(o.pos, o.quat, _s.set(1, 1, 1)); inst.setMatrixAt(i, _m); });
        this.scene.add(inst);
        continue;
      }
      const items = d.list.map((o) => ({
        m: _m.compose(o.pos, o.quat, _s.set(1, 1, 1)).clone(),
        color: type === 'barrel' ? tint[Math.floor(this.rnd() * tint.length)] : undefined,
        obj: o,
      }));
      // мелкие разрушаемые предметы — без теней (сотни штук), бочки и ящики — с тенями
      const cast = type === 'barrel' || type === 'crate';
      this.addChunked(d.g, d.mat, items, { cast, dynamic: true, tile: 160 });
    }
    this.tumbleweeds = this.dynamic.filter((o) => o.type === 'tumbleweed');
  }

  buildTumbleweeds() {
    for (let i = 0; i < (BIO.tumble ?? 18); i++) {
      const o = this.addDynamic('tumbleweed', (this.rnd() - 0.5) * 300, (this.rnd() - 0.5) * 300, 0);
      o.flying = true;
      o.tumble = true;
    }
  }

  // ---------- Столкновения машины ----------
  collideCar(car) {
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const out = this._tmp;
    for (const off of car.collisionCircles) {
      const ox = s * off, oz = c * off;
      const cx = car.pos.x + ox, cz = car.pos.z + oz;
      const r = car.radius;
      this.colliders.query(cx, cz, r + 4, out);
      for (const o of out) {
        if (car.pos.y > o.top + 0.2) continue; // перепрыгнули
        let nx, nz, pen;
        if (o.kind === 'c') {
          const dx = cx - o.x, dz = cz - o.z;
          const d = Math.hypot(dx, dz);
          pen = r + o.r - d;
          if (pen <= 0) continue;
          nx = d > 1e-4 ? dx / d : 1; nz = d > 1e-4 ? dz / d : 0;
        } else {
          const dx = cx - o.x, dz = cz - o.z;
          const lx = dx * o.c - dz * o.s, lz = dx * o.s + dz * o.c;
          const qx = clamp(lx, -o.hx, o.hx), qz = clamp(lz, -o.hz, o.hz);
          let ex = lx - qx, ez = lz - qz;
          let d = Math.hypot(ex, ez);
          if (d > 1e-4) {
            pen = r - d;
            if (pen <= 0) continue;
            ex /= d; ez /= d;
          } else {
            const px = o.hx - Math.abs(lx), pz = o.hz - Math.abs(lz);
            if (px < pz) { ex = Math.sign(lx) || 1; ez = 0; pen = px + r; } else { ex = 0; ez = Math.sign(lz) || 1; pen = pz + r; }
          }
          nx = ex * o.c + ez * o.s;
          nz = -ex * o.s + ez * o.c;
        }
        car.pos.x += nx * pen;
        car.pos.z += nz * pen;
        const vn = car.vel.x * nx + car.vel.z * nz;
        if (vn < 0) {
          const e = 0.25;
          const J = -(1 + e) * vn;
          car.vel.x += nx * J; car.vel.z += nz * J;
          car.vel.x *= 0.96; car.vel.z *= 0.96;
          car.yawRate += (oz * nx * J - ox * nz * J) * 0.12;
          if (J > 2) car.events.push({ type: 'hit', strength: J, x: cx - nx * r, z: cz - nz * r });
        }
      }
    }
    // Динамические объекты
    const spd = Math.hypot(car.vel.x, car.vel.z);
    for (const o of this.dynamic) {
      const dx0 = o.pos.x - car.pos.x, dz0 = o.pos.z - car.pos.z;
      if (dx0 * dx0 + dz0 * dz0 > 49) continue;
      if (o.pos.y - o.baseY > car.pos.y + 1.8 || car.pos.y > o.pos.y + o.baseY + 0.5) continue;
      for (const off of car.collisionCircles) {
        const cx = car.pos.x + s * off, cz = car.pos.z + c * off;
        const dx = o.pos.x - cx, dz = o.pos.z - cz;
        const d = Math.hypot(dx, dz);
        const rr = car.radius + o.r * 0.6;
        if (d >= rr) continue;
        const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
        if (spd > 2.5) {
          const k = 0.75 + Math.random() * 0.35;
          o.vel.set(car.vel.x * k + nx * 3, 2 + Math.random() * 3 + spd * 0.12, car.vel.z * k + nz * 3);
          o.ang.set((Math.random() - 0.5) * spd, (Math.random() - 0.5) * spd, (Math.random() - 0.5) * spd);
          o.flying = true;
          this.flying.add(o);
          const slow = o.type === 'tumbleweed' ? 0.998 : o.type === 'fence' ? 0.985 : 0.97;
          car.vel.x *= slow; car.vel.z *= slow;
          this.events.push({ type: 'smash', obj: o.type, x: o.pos.x, y: o.pos.y, z: o.pos.z, strength: spd });
        } else {
          o.pos.x += nx * (rr - d);
          o.pos.z += nz * (rr - d);
          this.flying.add(o);
          o.flying = true;
        }
        break;
      }
    }
  }

  // Столкновение «мяча» (бот/камера) со статикой — просто выталкивание
  pushOut(x, z, r, y, out) {
    const list = this.colliders.query(x, z, r + 4, this._tmp);
    out.x = x; out.z = z;
    for (const o of list) {
      if (y > o.top + 0.2) continue;
      if (o.kind === 'c') {
        const dx = out.x - o.x, dz = out.z - o.z, d = Math.hypot(dx, dz);
        if (d < r + o.r && d > 1e-4) { out.x = o.x + (dx / d) * (r + o.r); out.z = o.z + (dz / d) * (r + o.r); }
      }
    }
    return out;
  }

  update(dt, playerPos) {
    this.time += dt;
    this.shrubUniforms.uTime.value = this.time;
    const blink = Math.sin(this.time * 3.2) > 0.4 ? 5 : 0.3;
    for (const b of this.blinkers) b.emissiveIntensity = blink;
    for (const u of this.waters) u.uTime.value = this.time;
    for (const w of this.windmills) w.fan.rotation.z += w.speed * dt * (0.8 + 0.4 * Math.sin(this.time * 0.3 + w.speed));

    // Перекати-поле: катится по ветру, подпрыгивает, переносится к игроку
    for (const o of this.tumbleweeds) {
      const dx = o.pos.x - playerPos.x, dz = o.pos.z - playerPos.z;
      if (dx * dx + dz * dz > 230 * 230) {
        const a = Math.atan2(-WIND.z, -WIND.x) + (Math.random() - 0.5) * 1.6;
        const r = 120 + Math.random() * 90;
        o.pos.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
        o.pos.y = this.h(o.pos.x, o.pos.z) + o.baseY + 1;
        o.vel.set(0, 0, 0);
      }
      this.flying.add(o);
    }

    for (const o of this.flying) {
      const tw = o.type === 'tumbleweed';
      if (tw) {
        const gust = 0.7 + 0.6 * Math.sin(this.time * 0.7 + o.idx * 1.3);
        const tx = WIND.x * WIND.strength * 1.8 * gust, tz = WIND.z * WIND.strength * 1.8 * gust;
        o.vel.x += (tx - o.vel.x) * Math.min(1, dt * 0.8);
        o.vel.z += (tz - o.vel.z) * Math.min(1, dt * 0.8);
      }
      o.vel.y -= 9.81 * dt * (tw ? 0.6 : 1);
      o.pos.addScaledVector(o.vel, dt);
      const gy = this.h(o.pos.x, o.pos.z) + o.baseY * (o.type === 'fence' ? 0.25 : 0.8);
      if (o.pos.y < gy) {
        o.pos.y = gy;
        if (tw) {
          o.vel.y = 1.2 + Math.random() * 2.5;
        } else {
          o.vel.y = Math.abs(o.vel.y) > 2 ? -o.vel.y * 0.3 : 0;
          o.vel.x *= 0.7; o.vel.z *= 0.7;
          o.ang.multiplyScalar(0.6);
        }
      }
      if (tw) {
        // вращение качения
        const sp = Math.hypot(o.vel.x, o.vel.z);
        o.ang.set(o.vel.z / 0.55, 0, -o.vel.x / 0.55);
        if (sp < 0.01) o.ang.set(0, 0, 0);
      }
      const al = o.ang.length();
      if (al > 1e-4) {
        _q.setFromAxisAngle(_v.copy(o.ang).divideScalar(al), al * dt);
        o.quat.premultiply(_q);
      }
      _m.compose(o.pos, o.quat, _s.set(1, 1, 1));
      o.mesh.setMatrixAt(o.idx, _m);
      o.mesh.instanceMatrix.needsUpdate = true;
      if (!tw) o.mesh.boundingSphere = null; // объект вылетел — пересчитать границы тайла для отсечения
      if (!tw && o.vel.lengthSq() < 0.2 && o.pos.y <= gy + 0.01) {
        o.flying = false;
        this.flying.delete(o);
      }
    }
  }
}
