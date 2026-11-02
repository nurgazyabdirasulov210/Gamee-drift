// Физика машины: «велосипедная» модель шин с кривой Пасейки, перенос веса,
// ручник, импульс (буст), прыжки с барханов и трамплинов, визуальная подвеска.
import * as THREE from 'three';
import { buildCarModel } from './carModel.js';
import { clamp, lerp, smoothstep, damp } from './noise.js';
import { HALF } from './config.js';

const G = 9.81;
const AIR_G = 9.81 * 1.5;
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _n = new THREE.Vector3();

// Стили управления: «аркада» (по умолчанию) и «дрифт» — задний привод, скользкая корма,
// сильная поддержка угла заноса и большой угол руля для контрруления.
export const STYLES = {
  arcade: {
    label: 'АРКАДА', rearDrive: 0.68, muRear: 0.97, hb: 0.42, capDrive: 0.6, capMin: 0.35,
    BR: 7.0, CR: 1.6, steerLow: 0.62, steerHigh: 0.22, counter: 0.55, assist: 3.2,
    betaLimit: 0.85, betaK: 6, yawDamp: 0.35, kick: 0,
    airSpin: 6.5, airAcc: 10, donut: 2.6, donutNeedsHb: true, reverseSlide: 2.6,
  },
  drift: {
    label: 'ДРИФТ', rearDrive: 0.9, muRear: 0.86, hb: 0.3, capDrive: 0.85, capMin: 0.28,
    BR: 8.5, CR: 1.8, steerLow: 0.7, steerHigh: 0.42, counter: 0.7, assist: 5.0,
    betaLimit: 1.45, betaK: 3, yawDamp: 0.25, kick: 1.4, settle: 1.2, settleGrip: 1.0,
    airSpin: 9.5, airAcc: 15, donut: 3.4, donutNeedsHb: false, reverseSlide: 2.0,
  },
};

function pacejka(alpha, B, C) {
  return Math.sin(C * Math.atan(B * alpha));
}

export class Car {
  constructor(terrain, color = 0xf4f4f2) {
    this.terrain = terrain;
    this.kind = 'pickup';
    this.model = buildCarModel(color, this.kind);
    // постоянный контейнер: сам кузов можно менять на лету (гараж), фары и позиция остаются
    this.mesh = new THREE.Group();
    this.mesh.add(this.model.root);

    this.mass = 1450;
    this.inertia = 2500;
    this.spec = { power: 1, force: 1, mass: 1, grip: 1, boost: 1, scale: 1 };
    this.a = 1.38;            // ЦМ → передняя ось
    this.b = 1.42;            // ЦМ → задняя ось
    this.cgH = 0.62;
    this.R = 0.42;
    this.halfTrack = 0.9;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.yawRate = 0;
    this.delta = 0;            // угол поворота передних колёс
    this.grounded = true;
    this.contact = 1;
    this.airTime = 0;
    this.airRot = 0;
    this.groundH = 0;
    this.up = new THREE.Vector3(0, 1, 0);
    this.quat = new THREE.Quaternion();
    this.ax = 0; this.ay = 0;
    this.boost = 1;            // энергия импульса 0..1
    this.boosting = false;
    this.jumpCd = 0;
    this.throttle = 0; this.brake = 0; this.handbrake = false;
    this.surfaceRoad = 0;

    // визуальная подвеска кузова
    this.pitch = 0; this.pitchV = 0;
    this.roll = 0; this.rollV = 0;
    this.heave = 0; this.heaveV = 0;

    this.wheels = this.model.wheels.map((w) => ({
      ...w, spinAngle: 0, omega: 0, slipLat: 0, slipLong: 0,
      world: new THREE.Vector3(), prevWorld: new THREE.Vector3(), ground: 0, touching: true, susp: 0,
    }));

    this.events = [];          // {type:'land'|'hit', strength, pos}
    this.speed = 0;
    this.vf = 0; this.vl = 0;
    this.driftAngle = 0;
    this.collisionCircles = [-1.45, 0, 1.45];
    this.tune = STYLES.arcade;
    this.radius = 1.0;
  }

  reset(x, z, heading) {
    this.pos.set(x, this.terrain.getHeight(x, z), z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.yawRate = 0;
    this.delta = 0;
    this.grounded = true;
    this.groundH = this.pos.y;
    this.up.set(0, 1, 0);
    this.pitch = this.roll = this.heave = 0;
    this.pitchV = this.rollV = this.heaveV = 0;
    this._computeWheels();
    for (const w of this.wheels) w.prevWorld.copy(w.world);
    this.updateVisual(0);
  }

  // Сменить кузов (модель) на лету: колёса физики перепривязываются к новой модели
  setBody(kind) {
    if (kind === this.kind) return;
    const old = this.model;
    const color = old.paint.color.getHex(), glow = old.headMat.emissiveIntensity;
    this.mesh.remove(old.root);
    old.paint.dispose(); old.headMat.dispose(); old.tailMat.dispose();
    this.kind = kind;
    this.model = buildCarModel(color, kind);
    this.model.headMat.emissiveIntensity = glow;
    this.mesh.add(this.model.root);
    this.wheels.forEach((w, i) => { w.pivot = this.model.wheels[i].pivot; w.spin = this.model.wheels[i].spin; w.susp = 0; });
  }

  // Характеристики выбранной машины из гаража (множители к базовому джипу)
  setSpec(spec) {
    if (spec.kind) this.setBody(spec.kind);
    this.spec = spec;
    this.mass = 1450 * spec.mass;
    this.inertia = 2500 * spec.mass;
    this.mesh.scale.setScalar(spec.scale);
  }

  _computeWheels() {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    for (const w of this.wheels) {
      const wx = this.pos.x + s * w.z + c * w.x;
      const wz = this.pos.z + c * w.z - s * w.x;
      w.ground = this.terrain.getHeight(wx, wz);
      w.world.set(wx, w.ground, wz);
    }
  }

  step(dt, input) {
    const t = this.terrain;
    const m = this.mass;
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    const fx = s, fz = c;      // вперёд
    const lx = c, lz = -s;     // влево (локальная +X)

    this._computeWheels();
    const W = this.wheels;
    const gH = (W[0].ground + W[1].ground + W[2].ground + W[3].ground) / 4;
    const prevG = this.groundH;
    this.groundH = gH;
    const groundVy = dt > 0 ? (gH - prevG) / dt : 0;

    // Нормаль площадки по четырём колёсам
    const dzh = (W[0].ground + W[1].ground) / 2 - (W[2].ground + W[3].ground) / 2;
    const dxh = (W[0].ground + W[2].ground) / 2 - (W[1].ground + W[3].ground) / 2;
    const gzs = dzh / (this.a + this.b), gxs = dxh / (2 * this.halfTrack);
    _n.set(-fx * gzs - lx * gxs, 1, -fz * gzs - lz * gxs).normalize();

    // --- Вертикаль: следование рельефу, отрыв на гребнях, приземление ---
    if (this.grounded) {
      const vyFree = this.vel.y - AIR_G * dt;
      if (vyFree > groundVy + 2.6 || (input.jump && this.jumpCd <= 0)) {
        this.grounded = false;
        this.airTime = 0;
        this.airRot = 0;
        this.vel.y = Math.max(vyFree, groundVy);
        if (input.jump && this.jumpCd <= 0) {
          this.vel.y = Math.max(this.vel.y, 0) + 7.2;
          this.jumpCd = 1.1;
          this.events.push({ type: 'jump', strength: 1 });
        }
        this.pos.y += this.vel.y * dt;
      } else {
        this.pos.y = gH;
        this.vel.y = groundVy;
      }
    } else {
      this.airTime += dt;
      this.airRot += Math.abs(this.yawRate) * dt;
      this.vel.y -= AIR_G * dt;
      this.pos.y += this.vel.y * dt;
      if (this.pos.y <= gH) {
        const impact = groundVy - this.vel.y;
        this.pos.y = gH;
        this.vel.y = groundVy;
        this.grounded = true;
        if (impact > 2.5) {
          this.events.push({ type: 'land', strength: impact, air: this.airTime, spin: this.airRot * 57.3 });
          this.heaveV -= Math.min(impact, 20) * 0.18;
          this.pitchV += (Math.random() - 0.5) * impact * 0.05;
          if (impact > 9) { this.vel.x *= 0.95; this.vel.z *= 0.95; }
        }
      }
    }
    this.jumpCd -= dt;
    this.contact = this.grounded ? 1 : clamp(1 - (this.pos.y - gH) / 0.3, 0, 1);

    // --- Горизонталь ---
    let vf = this.vel.x * fx + this.vel.z * fz;
    let vl = this.vel.x * lx + this.vel.z * lz;
    const speed = Math.hypot(vf, vl);
    const road = t.roadAt(this.pos.x, this.pos.z);
    this.surfaceRoad = road;
    const mu = lerp(0.86, 1.08, road) * this.spec.grip;
    const rolling = lerp(0.045, 0.015, road);

    // Рулевое: меньше на скорости + контрруление в заносе
    const T = this.tune;
    const maxSteer = lerp(T.steerLow, T.steerHigh, smoothstep(4, 42, Math.abs(vf)));
    const beta = Math.atan2(vl, Math.max(Math.abs(vf), 0.5));
    let target = -input.steer * maxSteer;
    if (speed > 6 && vf > 0) target += clamp(beta, -0.6, 0.6) * T.counter;
    target = clamp(target, -0.8, 0.8);
    this.delta = damp(this.delta, target, 9, dt);
    const d = this.delta, cd = Math.cos(d), sd = Math.sin(d);

    this.boosting = input.boost && this.boost > 0.02 && this.contact > 0.2;
    if (this.boosting) this.boost = Math.max(0, this.boost - dt * 0.32 / this.spec.boost);
    else this.boost = Math.min(1, this.boost + dt * 0.06);

    // Двигатель / тормоз / задний ход
    const P = (this.boosting ? 360000 : 215000) * this.spec.power;
    const maxF = (this.boosting ? 15500 : 11500) * this.spec.force;
    let Fdrive = 0, Fbrake = 0;
    this.throttle = input.throttle;
    this.brake = input.brake;
    if (input.throttle > 0) Fdrive = input.throttle * Math.min(maxF, P / Math.max(Math.abs(vf), 1));
    // Едем задом после разворота на 180°: колёса буксуют, машина долго катится задом наперёд
    this.reverseSliding = vf < -3 && input.brake <= 0;
    if (this.reverseSliding && Fdrive > 0) Fdrive = Math.min(Fdrive, m * T.reverseSlide);
    if (input.brake > 0) {
      if (vf > 1.2) Fbrake = input.brake * 13000;
      else if (vf > -13) Fdrive -= input.brake * 7000;
    }
    if (this.boosting && input.throttle <= 0 && input.brake <= 0) Fdrive = Math.min(maxF, P / Math.max(Math.abs(vf), 1));
    Fbrake = Math.min(Fbrake, (Math.abs(vf) * m) / dt * 0.5);

    // Нагрузка на оси (перенос веса)
    const L = this.a + this.b;
    const Fz = m * G * Math.max(0.2, this.contact);
    let FzF = (Fz * this.b) / L - (m * this.ax * this.cgH) / L;
    let FzR = (Fz * this.a) / L + (m * this.ax * this.cgH) / L;
    FzF = Math.max(FzF, 0.15 * Fz); FzR = Math.max(FzR, 0.15 * Fz);

    const hb = input.handbrake;
    this.handbrake = hb;
    const muF = mu * 1.05;
    // без руля и ручника корма возвращает сцепление — машина выравнивается
    const slideIntent = clamp(Math.abs(input.steer) * 1.6 + (hb ? 1 : 0), 0, 1);
    // «Пончик»/разворот на месте: газ + полный руль на малой скорости (в аркаде — ещё и ручник)
    const donut = this.grounded && input.throttle > 0 && Math.abs(input.steer) > 0.4 && speed < 16
      && (!T.donutNeedsHb || hb);
    this.donut = donut;
    const muR = mu * lerp(T.settleGrip ?? T.muRear, T.muRear, slideIntent) * (hb ? T.hb : 1) * (donut ? 0.4 : 1);

    // Продольные силы
    const sv = Math.sign(vf) || 0;
    let FxF = (1 - T.rearDrive) * Fdrive - sv * Fbrake * 0.6;
    let FxR = T.rearDrive * Fdrive - sv * Fbrake * 0.4;
    if (hb && Math.abs(vf) > 0.5) FxR -= sv * muR * FzR * 0.8;
    const maxFF = muF * FzF, maxFR = muR * FzR;
    FxF = clamp(FxF, -maxFF, maxFF);
    FxR = clamp(FxR, -maxFR, maxFR);

    // Боковые силы
    const vlf = vl + this.yawRate * this.a;
    const vlr = vl - this.yawRate * this.b;
    const vlongF = vf * cd + vlf * sd;
    const vlatF = -vf * sd + vlf * cd;
    const alphaF = Math.atan2(vlatF, Math.max(Math.abs(vlongF), 2.0));
    const alphaR = Math.atan2(vlr, Math.max(Math.abs(vf), 2.0));
    const capF = Math.sqrt(Math.max(0, 1 - (FxF / maxFF) ** 2 * 0.7));
    // Буксование ведущих колёс съедает боковое сцепление (заносы на газу), тормоз — меньше
    const driveShare = FxR * sv >= 0 ? T.capDrive : 0.3;
    const capR = Math.max(T.capMin, Math.sqrt(Math.max(0, 1 - (FxR / maxFR) ** 2 * driveShare)));
    const FyF = -muF * FzF * pacejka(alphaF, 7.5, 1.55) * capF;
    const FyR = -muR * FzR * pacejka(alphaR, T.BR, T.CR) * capR;

    let Flong = FxF * cd - FyF * sd + FxR;
    let Flat = FxF * sd + FyF * cd + FyR;
    let torque = this.a * (FxF * sd + FyF * cd) - this.b * FyR;

    // Аркадная помощь в заносе: поддержка скорости и ограничение угла
    if (vf > 4 && Math.abs(beta) > 0.18) {
      const assist = input.throttle * Math.abs(Math.sin(beta)) * m * T.assist;
      const vlen = speed || 1;
      Flong += assist * (vf / vlen);
      Flat += assist * (vl / vlen);
      const excess = Math.abs(beta) - T.betaLimit;
      if (excess > 0) this.yawRate += Math.sign(beta) * excess * T.betaK * dt;
    }

    const c01 = this.contact;
    Flong *= c01; Flat *= c01; torque *= c01;

    // Сопротивление: качение (песок вязкий) + воздух
    const roll = rolling * m * G * clamp(vf / 1.5, -1, 1) * c01;
    Flong -= roll;
    if (input.throttle <= 0 && !this.boosting) Flong -= m * (vf < 0 ? 0.35 : 0.7) * clamp(vf / 2, -1, 1) * c01; // торможение двигателем
    const aero = 0.62;
    let ax = (fx * Flong + lx * Flat) / m - (aero * this.vel.x * speed) / m;
    let az = (fz * Flong + lz * Flat) / m - (aero * this.vel.z * speed) / m;
    // Гравитация вдоль склона
    if (this.grounded) {
      ax += G * _n.x * 0.9;
      az += G * _n.z * 0.9;
    }

    this.vel.x += ax * dt;
    this.vel.z += az * dt;
    this.yawRate += (torque / this.inertia) * dt;
    if (!this.grounded) {
      // В полёте руль раскручивает машину: можно сделать 360–720°
      if (Math.abs(input.steer) > 0.05) {
        const tgt = -input.steer * T.airSpin;
        this.yawRate += clamp(tgt - this.yawRate, -T.airAcc * dt, T.airAcc * dt);
      } else this.yawRate *= Math.exp(-0.25 * dt);
    } else {
      if (donut) {
        const tgt = -Math.sign(input.steer) * T.donut * Math.min(1, Math.abs(input.steer) * 1.4);
        this.yawRate += clamp(tgt - this.yawRate, -6 * dt, 6 * dt);
      }
      this.yawRate *= Math.exp(-(T.yawDamp + (T.settle || 0) * (1 - Math.min(1, Math.abs(input.steer) * 2))) * dt);
      // «Вброс» в занос: резкий руль на скорости закручивает корму
      if (T.kick && this.grounded && vf > 12 && Math.abs(input.steer) > 0.6 && Math.abs(beta) < 0.5) {
        this.yawRate += -input.steer * T.kick * (input.handbrake ? 1.5 : 1) * dt;
      }
    }
    // Стабилизация на месте
    if (speed < 0.8 && input.throttle <= 0 && input.brake <= 0 && this.grounded) {
      const k = Math.exp(-5 * dt);
      this.vel.x *= k; this.vel.z *= k; this.yawRate *= Math.exp(-8 * dt);
    }
    this.heading += this.yawRate * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Границы мира
    const lim = HALF - 25;
    if (Math.abs(this.pos.x) > lim) { this.pos.x = Math.sign(this.pos.x) * lim; this.vel.x *= -0.3; }
    if (Math.abs(this.pos.z) > lim) { this.pos.z = Math.sign(this.pos.z) * lim; this.vel.z *= -0.3; }

    // Продольное ускорение для переноса веса и крена кузова
    const latAcc = Flat / m;
    this.ax = damp(this.ax, Flong / m, 8, dt);
    this.ay = damp(this.ay, latAcc, 8, dt);

    // Нормаль для визуала
    if (this.grounded) this.up.lerp(_n, 1 - Math.exp(-14 * dt)).normalize();
    else {
      _v.set(0, 1, 0);
      this.up.lerp(_v, 1 - Math.exp(-1.2 * dt)).normalize();
    }

    // Состояние для эффектов
    vf = this.vel.x * fx + this.vel.z * fz;
    vl = this.vel.x * lx + this.vel.z * lz;
    this.vf = vf; this.vl = vl;
    this.speed = Math.hypot(vf, vl);
    this.driftAngle = this.speed > 3 ? Math.atan2(vl, Math.abs(vf)) : 0;

    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const lat = i < 2 ? vlatF : vlr;
      let omega = vf / this.R;
      let slipLong = 0;
      if (i >= 2) {
        if (hb) { omega = 0; slipLong = Math.abs(vf); }
        else if (input.throttle > 0) {
          const spinX = input.throttle * (1 - smoothstep(0, 16, this.speed)) * 30 * (this.boosting ? 1.5 : 1);
          omega += spinX;
          slipLong = spinX * this.R;
        }
      }
      if (Fbrake > 0 && Math.abs(vf) > 3 && input.brake > 0.8) slipLong = Math.max(slipLong, Math.abs(vf) * 0.25);
      w.omega = this.grounded ? omega : w.omega * Math.exp(-0.5 * dt);
      w.spinAngle += w.omega * dt;
      w.slipLat = Math.abs(lat) * this.contact;
      w.slipLong = slipLong * this.contact;
    }

    // Визуальная подвеска (пружины)
    const kP = 90, cP = 11;
    const pitchT = clamp(-this.ax * 0.009, -0.09, 0.09);
    const rollT = clamp(this.ay * 0.011, -0.1, 0.1);
    this.pitchV += ((pitchT - this.pitch) * kP - this.pitchV * cP) * dt;
    this.rollV += ((rollT - this.roll) * kP - this.rollV * cP) * dt;
    this.heaveV += ((0 - this.heave) * 140 - this.heaveV * 12) * dt;
    this.pitch += this.pitchV * dt;
    this.roll += this.rollV * dt;
    this.heave += this.heaveV * dt;
    this.heave = clamp(this.heave, -0.25, 0.2);
  }

  updateVisual() {
    const root = this.mesh;
    _z.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    // проекция «вперёд» на плоскость нормали
    _z.addScaledVector(this.up, -_z.dot(this.up)).normalize();
    _x.crossVectors(this.up, _z).normalize();
    _m.makeBasis(_x, this.up, _z);
    this.quat.setFromRotationMatrix(_m);
    root.position.copy(this.pos);
    root.quaternion.copy(this.quat);
    root.updateMatrixWorld(true);

    const body = this.model.body;
    body.position.y = this.heave;
    body.rotation.set(this.pitch, 0, this.roll);

    _mi.copy(root.matrixWorld).invert();
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      _v.set(w.world.x, w.ground, w.world.z).applyMatrix4(_mi);
      const wr = this.model.wheelR;
      let y = _v.y + wr;
      if (!this.grounded) y = wr - 0.16;
      y = clamp(y, wr - 0.22, wr + 0.2);
      w.susp = damp(w.susp, y, 30, 1 / 60);
      w.pivot.position.y = w.susp;
      w.pivot.rotation.y = w.front ? this.delta : 0;
      w.spin.rotation.x = w.spinAngle;
    }
    // Стоп-сигналы
    this.model.tailMat.emissiveIntensity = this.brake > 0.1 || this.handbrake ? 3.5 : 0.6;
  }

  // Мировые точки контакта колёс для эффектов
  wheelContact(i, out) {
    const w = this.wheels[i];
    return out.set(w.world.x, w.ground, w.world.z);
  }
}
