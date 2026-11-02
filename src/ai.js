// Боты-соперники: едут по гоночной траектории (внешний край — апекс — внешний край),
// входят в поворот «маятником», держат занос с контррулением и выравниваются на выходе,
// тормозят перед крутыми поворотами, обгоняют со сменой полосы, толкаются, прыгают с трамплинов, пылят.
// Модель кинематическая: точка с вектором скорости догоняет цель на траектории (pure pursuit),
// а угол заноса — отдельная пружина поверх направления движения. Движение всегда непрерывное.
import * as THREE from 'three';
import { buildCarModel } from './carModel.js';
import { clamp, damp, lerp, smoothstep } from './noise.js';

const _x = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _n = new THREE.Vector3();
const _S = { x: 0, z: 0, dx: 0, dz: 1 }; // выборка трассы без аллокаций

const TAU = Math.PI * 2;
const AIR_G = 14.7;          // гравитация в полёте, как у машины игрока
const LINE_MAX = 6.2;        // насколько гоночная линия уходит от оси трассы, м
const LANE_MAX = 7.4;        // крайняя полоса по укатанной трассе
const LANE_SAND = 9.8;       // при объезде можно зацепить песок у обочины
const V_TOP = 38;            // скорость на прямой (до множителя мастерства), м/с
const A_LAT = 6.5;           // боковое ускорение в повороте — задаёт скорость прохождения
const A_BRAKE = 6.5;         // замедление для расчёта точек торможения
const ACC = 7, POWER = 200, BRAKE = 10; // разгон (ограничен «мощностью» на скорости) и тормоз
const A_CAP = 20;            // предел кривизны траектории (запас над A_LAT для манёвров и возврата)
const CIRCLES = [-1.45, 0, 1.45], CR = 1.0; // круги столкновений вдоль кузова, как у машины игрока

const wrapA = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);

function arrAt(arr, s) {
  const N = arr.length;
  let i = Math.floor(s);
  const t = s - i;
  i %= N; if (i < 0) i += N;
  const j = i + 1 === N ? 0 : i + 1;
  return arr[i] + (arr[j] - arr[i]) * t;
}

// Точка и направление оси трассы в дробном индексе s (с переходом через ноль)
function sampleTrack(tr, s, out) {
  const N = tr.count;
  let i = Math.floor(s);
  const t = s - i;
  i %= N; if (i < 0) i += N;
  const j = i + 1 === N ? 0 : i + 1;
  const a = tr.points[i], b = tr.points[j], da = tr.dirs[i], db = tr.dirs[j];
  const dx = da.x + (db.x - da.x) * t, dz = da.z + (db.z - da.z) * t;
  const l = Math.hypot(dx, dz) || 1;
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t;
  out.dx = dx / l; out.dz = dz / l;
  return out;
}

// Общие для трассы данные: гоночная линия, её кривизна, профиль скорости, список ботов
const SHARED = new WeakMap();

// Линия минимальной кривизны внутри коридора ±LINE_MAX: проекционный Гаусс-Зейдель (с верхней
// релаксацией) по сумме квадратов вторых разностей точек P[i] = C[i] + n[i]·line[i].
function relaxLine(M, X, Z, NX, NZ, line, levels, iters) {
  for (const k of levels) {
    const k2 = 2 * k;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < M; i++) {
        let a2 = i - k2; if (a2 < 0) a2 += M;
        let a1 = i - k; if (a1 < 0) a1 += M;
        let b1 = i + k; if (b1 >= M) b1 -= M;
        let b2 = i + k2; if (b2 >= M) b2 -= M;
        const gx = X[a2] + NX[a2] * line[a2] + X[b2] + NX[b2] * line[b2]
          - 4 * (X[a1] + NX[a1] * line[a1] + X[b1] + NX[b1] * line[b1]) + 6 * X[i];
        const gz = Z[a2] + NZ[a2] * line[a2] + Z[b2] + NZ[b2] * line[b2]
          - 4 * (Z[a1] + NZ[a1] * line[a1] + Z[b1] + NZ[b1] * line[b1]) + 6 * Z[i];
        const l = line[i] + 1.6 * (-(gx * NX[i] + gz * NZ[i]) / 6 - line[i]);
        // крошечные значения обнуляем: денормализованные числа в разы замедляют арифметику
        line[i] = l > LINE_MAX ? LINE_MAX : l < -LINE_MAX ? -LINE_MAX : (l > 1e-6 || l < -1e-6) ? l : 0;
      }
    }
  }
}

function sharedFor(track) {
  let sh = SHARED.get(track);
  if (sh) return sh;
  const N = track.count, P = track.points, D = track.dirs;
  // Сначала на прореженной трассе (быстро сходится на длинных дугах), затем уточнение на полной
  const SUB = 4, M = Math.floor(N / SUB);
  const X = new Float64Array(M), Z = new Float64Array(M), NX = new Float64Array(M), NZ = new Float64Array(M);
  for (let j = 0; j < M; j++) {
    const i = Math.floor((j * N) / M);
    X[j] = P[i].x; Z[j] = P[i].z; NX[j] = D[i].z; NZ[j] = -D[i].x;
  }
  const lc = new Float64Array(M);
  relaxLine(M, X, Z, NX, NZ, lc, [3, 1], 120);
  const line = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const f = (i * M) / N, j = Math.floor(f), t = f - j;
    const p0 = lc[(j - 1 + M) % M], p1 = lc[j % M], p2 = lc[(j + 1) % M], p3 = lc[(j + 2) % M];
    line[i] = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
  }
  const FX = new Float64Array(N), FZ = new Float64Array(N), FNX = new Float64Array(N), FNZ = new Float64Array(N);
  for (let i = 0; i < N; i++) { FX[i] = P[i].x; FZ[i] = P[i].z; FNX[i] = D[i].z; FNZ[i] = -D[i].x; }
  relaxLine(N, FX, FZ, FNX, FNZ, line, [1], 12);
  const px = new Float32Array(N), pz = new Float32Array(N);
  for (let i = 0; i < N; i++) { px[i] = P[i].x + D[i].z * line[i]; pz[i] = P[i].z - D[i].x * line[i]; }
  // Кривизна линии со знаком (+ — поворот влево)
  let curv = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 2 + N) % N, b = (i + 2) % N;
    const ax = px[i] - px[a], az = pz[i] - pz[a], bx = px[b] - px[i], bz = pz[b] - pz[i];
    const den = Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz);
    curv[i] = den > 1e-6 ? (-2 * (ax * bz - az * bx)) / den : 0;
  }
  for (let pass = 0; pass < 3; pass++) {
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) o[i] = (curv[(i - 1 + N) % N] + 2 * curv[i] + curv[(i + 1) % N]) / 4;
    curv = o;
  }
  // Профиль скорости: предел по сцеплению + торможение заранее (обратный проход по кругу)
  const vprof = new Float32Array(N);
  for (let i = 0; i < N; i++) vprof[i] = Math.min(V_TOP, Math.sqrt(A_LAT / Math.max(Math.abs(curv[i]), 1e-5)));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const j = (i + 1) % N;
      const ds = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
      vprof[i] = Math.min(vprof[i], Math.sqrt(vprof[j] * vprof[j] + 2 * A_BRAKE * ds));
    }
  }
  sh = { line, curv, vprof, bots: [], ramps: [], rampN: -1 };
  SHARED.set(track, sh);
  return sh;
}

// Трамплины, стоящие на трассе по ходу движения (ищем один раз, когда мир их расставил)
function findTrackRamps(sh, track, terrain) {
  sh.rampN = terrain.ramps.length;
  sh.ramps.length = 0;
  for (const r of terrain.ramps) {
    const nn = track.nearest(r.x, r.z);
    if (nn.dist > track.width / 2) continue;
    const d = track.dir(nn.index), p = track.point(nn.index);
    if (r.dx * d.x + r.dz * d.z < 0.8) continue;
    sh.ramps.push({ idx: nn.index, lane: (r.x - p.x) * d.z - (r.z - p.z) * d.x, half: r.width / 2 });
  }
}

export class Bot {
  constructor(track, terrain, color, skill, offset, kind = 'pickup') {
    this.track = track;
    this.terrain = terrain;
    this.model = buildCarModel(color, kind);
    this.mesh = this.model.root;
    this.skill = skill;
    this.sh = sharedFor(track);
    this.sh.bots.push(this);

    // Характер: точность линии, угол заноса, резкость «маятника», разброс полосы
    this.pace = skill;
    this.lineK = clamp(0.62 + (skill - 0.93) * 5.5, 0.6, 1);
    this.driftMax = 0.52 + Math.random() * 0.18;
    this.flickK = 0.75 + Math.random() * 0.5;
    this.biasAmp = 0.6 + (1 - this.lineK) * 2.5;
    this.phase = Math.random() * TAU;

    this.s = offset;              // позиция вдоль трассы (индекс, дробный)
    this.lap = 0;
    this.lane = 0;                // фактическое смещение от оси трассы (+ влево)
    this.speed = 0;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;             // куда смотрит кузов
    this.psi = 0;                 // куда направлена скорость
    this.w = 0;                   // скорость поворота траектории
    this.slide = 0;               // угол заноса (кузов относительно скорости)
    this.slideV = 0;
    this.driftAngle = 0;
    this.kx = 0; this.kz = 0;     // боковой «отброс» после удара, затухает
    this.vy = 0;
    this.grounded = true;
    this.groundH = 0;
    this.landed = 0;
    this.up = new THREE.Vector3(0, 1, 0);
    this.racing = false;
    this.wait = 0;
    this.time = 0;
    this.accel = 0;
    this.braking = false;
    this.hitCd = 0;
    // визуал: руль, подвеска, вращение колёс
    this.steer = 0;
    this.roll = 0; this.rollV = 0; this.rollT = 0;
    this.pitch = 0; this.pitchV = 0; this.pitchT = 0;
    this.heave = 0; this.heaveV = 0;
    this.spinF = 0; this.spinR = 0;
    this.droop = 0.42;
    this.resetAt(offset, (Math.random() - 0.5) * 6, false);
  }

  resetAt(index, lane, racing) {
    const tr = this.track, N = tr.count;
    this.s = ((index % N) + N) % N;
    this.lap = 0;
    this.racing = racing;
    this.wait = racing ? 3.2 : 0;
    sampleTrack(tr, this.s, _S);
    const x = _S.x + _S.dz * lane, z = _S.z - _S.dx * lane;
    this.pos.set(x, this.terrain.getHeight(x, z), z);
    this.groundH = this.pos.y;
    this.vy = 0;
    this.grounded = true;
    this.lane = lane;
    this.psi = Math.atan2(_S.dx, _S.dz);
    this.heading = this.psi;
    this.w = 0;
    this.slide = 0; this.slideV = 0; this.driftAngle = 0;
    this.speed = 0;
    this.kx = 0; this.kz = 0;
    this.vel.set(0, 0, 0);
    this.accel = 0;
    this.steer = 0;
    // полосы: стартовая держится первые секунды, потом бот уходит на свою линию
    this.startLane = lane;
    this.startBlend = 1;
    this.bias = 0; this.biasTarget = 0; this.biasT = 2 + Math.random() * 6;
    this.avoidObj = null; this.avoidLane = lane; this.avoidSide = 1; this.avoidW = 0; this.avoidHold = 0;
    this.followCap = Infinity;
    this.crowd = 0; this.driftAmt = 0;
    this.rampFor = null; this.rampWant = false; this.rampLane = 0; this.rampW = 0; this.rampAim = false;
    // прогресс игрока (для «резинки» в гонке)
    this.rubber = 1;
    this.pIdx = -1; this.pLap = 0; this.pDist = 0; this.pScan = 0;
    this.terrain.getNormal(x, z, this.up, 1.4);
    this._pose(0);
  }

  update(dt, player) {
    if (!(dt > 0)) return;
    const sh = this.sh, tr = this.track, step = tr.step;
    const ramps = this.terrain.ramps;
    if (ramps && ramps.length !== sh.rampN) findTrackRamps(sh, tr, this.terrain);
    this.time += dt;
    if (this.wait > 0) { this.wait -= dt; this.vel.set(0, 0, 0); this._pose(dt); return; }
    this.hitCd -= dt;

    // Рамка трассы в текущей точке
    sampleTrack(tr, this.s, _S);
    const tx = _S.dx, tz = _S.dz;

    let pace = this.pace;
    if (this.racing) pace *= this._rubber(dt, player);
    else this.rubber = 1;

    this._traffic(dt, player, tx, tz);
    this._rampPlan(dt);
    this.biasT -= dt;
    if (this.biasT <= 0) {
      this.biasT = 6 + Math.random() * 12;
      this.biasTarget = (Math.random() - 0.5) * 2 * this.biasAmp;
    }
    this.bias = damp(this.bias, this.biasTarget, 0.4, dt);
    this.startBlend = damp(this.startBlend, 0, 0.45, dt);

    // Руление: цель на траектории впереди (pure pursuit), без рывков
    let v = this.speed;
    let L = clamp(7 + v * 0.42, 8, 26);
    // перед трамплином целимся в точку приземления — после полёта машина не улетает с трассы
    if (this.rampAim) L = Math.max(L, Math.min(70, v * 1.4));
    const sT = this.s + L / step;
    const laneT = this._laneCmd(sT);
    sampleTrack(tr, sT, _S);
    const ex = _S.x + _S.dz * laneT - this.pos.x, ez = _S.z - _S.dx * laneT - this.pos.z;
    const dist = Math.hypot(ex, ez) || 1;
    const ang = clamp(wrapA(Math.atan2(ex, ez) - this.psi), -1.5, 1.5);
    const vs = Math.max(v, 1.5);
    const wMax = Math.min(2.2, A_CAP / Math.max(v, 4));
    const wCmd = clamp((2 * Math.sin(ang) * vs) / dist, -wMax, wMax);
    this.w = this.grounded ? damp(this.w, wCmd, 10, dt) : damp(this.w, 0, 2, dt);

    // Скорость: профиль с торможением перед поворотами, разгон на выходе, дистанция до впереди идущего
    let vT = arrAt(sh.vprof, this.s + (v * 0.35) / step) * pace;
    const off = Math.abs(this.lane) - (tr.width / 2 - 0.8);
    if (off > 0) vT *= 1 - 0.12 - 0.35 * smoothstep(0, 18, off);   // песок вне трассы
    vT *= 1 - 0.5 * smoothstep(0.2, 0.9, Math.abs(ang));          // смотрит мимо цели — сбросить газ
    if (this.followCap < vT) vT = this.followCap;
    const v0 = v;
    if (this.grounded) {
      if (vT > v) v = Math.min(vT, v + Math.min(ACC, POWER / Math.max(v, 1)) * this.skill * dt);
      else v = Math.max(vT, v - (v - vT > 4 && this.followCap < Infinity ? BRAKE * 1.4 : BRAKE) * dt);
    }
    this.speed = v;
    this.braking = this.grounded && vT < v0 - 0.8;
    this.accel = damp(this.accel, (v - v0) / dt, 6, dt);

    // Движение
    if (this.grounded) this.psi = wrapA(this.psi + this.w * dt);
    const sp = Math.sin(this.psi), cp = Math.cos(this.psi);
    const kd = Math.exp(-2.2 * dt);
    this.kx *= kd; this.kz *= kd;
    const vx = sp * v + this.kx, vz = cp * v + this.kz;
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;

    // Вертикаль с отрывом (трамплины и гребни)
    const g = this.terrain.getHeight(this.pos.x, this.pos.z);
    const gVy = (g - this.groundH) / dt;
    this.groundH = g;
    if (this.grounded) {
      const vyFree = this.vy - AIR_G * dt;
      if (vyFree > gVy + 2.6) { this.grounded = false; this.vy = vyFree; this.pos.y += this.vy * dt; }
      else { this.pos.y = g; this.vy = gVy; }
    } else {
      this.vy -= AIR_G * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= g) {
        const impact = Math.max(0, gVy - this.vy);
        this.pos.y = g; this.vy = gVy; this.grounded = true; this.landed = impact;
        this.heaveV -= Math.min(impact, 20) * 0.16;
        this.pitchV += (Math.random() - 0.5) * impact * 0.04;
        this.slideV += (Math.random() - 0.5) * impact * 0.06;
      }
    }

    this._project();
    sampleTrack(tr, this.s, _S);
    this.lane = (this.pos.x - _S.x) * _S.dz - (this.pos.z - _S.z) * _S.dx;

    this._drift(dt);

    this.vel.set(vx, this.vy, vz);
    this._collide(player, true);
    const bots = sh.bots;
    let after = false;
    for (let k = 0; k < bots.length; k++) {
      const b = bots[k];
      if (b === this) { after = true; continue; }
      if (after && b.wait <= 0) this._collide(b, false);
    }
    this._pose(dt);
  }

  // Угол заноса: пружина к цели по кривизне впереди; перед входом — «маятник» в обратную сторону
  _drift(dt) {
    const sh = this.sh, step = this.track.step, v = this.speed;
    const kLead = arrAt(sh.curv, this.s + (v * 0.25 + 2) / step);
    const kFar = arrAt(sh.curv, this.s + (v * 0.85 + 6) / step);
    const kD = 0.55 * kLead + 0.45 * (this.w / Math.max(v, 3));
    const aK = Math.abs(kD);
    const amt = this.grounded
      ? smoothstep(2, 5, v * v * aK) * smoothstep(0.004, 0.009, aK) * smoothstep(6, 13, v)
      : 0;
    this.driftAmt = amt;
    let tgt = Math.sign(kD) * amt * this.driftMax * (0.72 + 0.28 * smoothstep(0.012, 0.03, aK));
    tgt += amt * 0.035 * Math.sin(this.time * 2.7 + this.phase); // газ «дышит» — угол чуть гуляет
    tgt *= 1 - 0.5 * this.crowd;                                   // борт в борт — занос аккуратнее
    const aF = Math.abs(kFar);
    const amtFar = smoothstep(2, 5, v * v * aF) * smoothstep(0.005, 0.011, aF) * smoothstep(8, 14, v);
    if (amtFar > 0.3 && Math.abs(tgt) < 0.12) tgt = -Math.sign(kFar) * 0.16 * this.flickK * amtFar;

    if (this.grounded) {
      const entering = Math.abs(tgt) > Math.abs(this.slide);
      const wn = entering ? 7 : 4.5, zeta = entering ? 0.45 : 0.9;
      this.slideV += (wn * wn * (tgt - this.slide) - 2 * zeta * wn * this.slideV) * dt;
    } else this.slideV *= Math.exp(-2 * dt);
    this.slide = clamp(this.slide + this.slideV * dt, -1.1, 1.1);
    if (Math.abs(this.slide) === 1.1) this.slideV = 0;
    this.driftAngle = this.slide;
    this.heading = wrapA(this.psi + this.slide);

    // Передние колёса: геометрия поворота + контрруление по углу заноса
    const geo = Math.atan((2.8 * this.w) / Math.max(v, 3));
    const steerT = clamp(geo * (1 - 0.7 * amt) - this.slide * 0.9 - this.slideV * 0.05, -0.7, 0.7);
    this.steer = damp(this.steer, steerT, 14, dt);
    this.rollT = clamp(v * this.w * 0.011, -0.09, 0.09);
    this.pitchT = clamp(-this.accel * 0.009, -0.07, 0.07);
  }

  // Проекция позиции на ось трассы: локальный поиск сегмента, счёт кругов при переходе через ноль
  _project() {
    const tr = this.track, N = tr.count, P = tr.points;
    let i = Math.floor(this.s) % N, t = 0, dir = 0;
    for (let it = 0; it < 10; it++) {
      const a = P[i], b = P[i + 1 === N ? 0 : i + 1];
      const ex = b.x - a.x, ez = b.z - a.z;
      t = ((this.pos.x - a.x) * ex + (this.pos.z - a.z) * ez) / (ex * ex + ez * ez);
      if (t > 1 && dir >= 0) { dir = 1; i++; if (i >= N) { i = 0; this.lap++; } continue; }
      if (t < 0 && dir <= 0) { dir = -1; i--; if (i < 0) { i = N - 1; this.lap--; } continue; }
      break;
    }
    this.s = i + clamp(t, 0, 0.9999);
  }

  _laneBase(sAt) {
    let l = arrAt(this.sh.line, sAt) * this.lineK + this.bias;
    if (this.startBlend > 0.001) l = lerp(l, this.startLane, this.startBlend);
    if (this.rampW > 0.001) l = lerp(l, this.rampLane, this.rampW);
    return clamp(l, -LANE_MAX, LANE_MAX);
  }

  _laneCmd(sAt) {
    const l = this._laneBase(sAt);
    return this.avoidW > 0.001 ? lerp(l, this.avoidLane, this.avoidW) : l;
  }

  // Игрок и другие боты впереди: выбрать сторону обгона, не въезжать в корму
  _traffic(dt, player, tx, tz) {
    const tr = this.track, hw = tr.width / 2, step = tr.step, bots = this.sh.bots, v = this.speed;
    const trackH = Math.atan2(tx, tz);
    const selfW = 1.0 + 1.35 * Math.abs(Math.sin(this.heading - trackH)); // в заносе корма шире
    let found = null, fAhead = Infinity, fLane = 0, fClr = 0, fVo = 0, crowd = 0, cap = Infinity;
    for (let k = -1; k < bots.length; k++) {
      const o = k < 0 ? player : bots[k];
      if (!o || o === this || !o.pos) continue;
      const dx = o.pos.x - this.pos.x, dz = o.pos.z - this.pos.z;
      if (dx * dx + dz * dz > 4900 || Math.abs(o.pos.y - this.pos.y) > 3) continue;
      const ahead = dx * tx + dz * tz;
      // смещение соперника считаем в рамке трассы у него самого — на изгибе рамка бота врёт
      sampleTrack(tr, this.s + ahead / step, _S);
      const oLane = (o.pos.x - _S.x) * _S.dz - (o.pos.z - _S.z) * _S.dx;
      const side = oLane - this.lane;
      if (Math.abs(oLane) > hw + 3.5) continue;
      if (ahead > -7 && ahead < 8 && Math.abs(side) < 5.5) crowd = 1; // кто-то борт в борт
      const vo = o.vel ? o.vel.x * _S.dx + o.vel.z * _S.dz : 0;
      const range = Math.min(vo < -2 ? 85 : 65, 9 + Math.max(0, v - vo) * 2.2 + v * 0.2);
      if (ahead < -4.5 || ahead > range) continue;
      const oh = o.heading;
      const clr = selfW + 1.2
        + (Number.isFinite(oh) ? 1.05 + 1.35 * Math.abs(Math.sin(oh - Math.atan2(_S.dx, _S.dz))) : 1.6);
      if (o !== this.avoidObj) {
        // мешает, если попадает в полосу между текущим смещением и тем, куда бот собирался
        const planned = lerp(this.lane, this._laneBase(this.s + Math.max(0, ahead) / step), clamp(ahead / 25, 0, 1));
        const lo = Math.min(this.lane, planned), hi = Math.max(this.lane, planned);
        if (oLane + clr <= lo || oLane - clr >= hi) continue;
      }
      // пока не разошлись по ширине — держим дистанцию, а не таранить (по всем мешающим)
      if (ahead > 0 && Math.abs(side) < clr - 0.3) {
        const d = ahead - (6.5 + v * 0.12);
        let c = Math.max(0, vo) + (d > 0 ? Math.sqrt(14 * d) : d * 0.6); // успеть оттормозиться
        if (vo < -2) c = Math.max(c, 9);   // навстречу — не замирать, а уходить вбок
        else if (ahead > 5) c = Math.max(c, 2.5);
        if (c < cap) cap = Math.max(0, c);
      }
      if (ahead < fAhead) { found = o; fAhead = ahead; fLane = oLane; fClr = clr; fVo = vo; }
    }
    this.followCap = cap;
    if (found) {
      // сторона объезда: ближняя свободная; уже выбранную меняем только если другая заметно лучше
      const cL = fLane + fClr, cR = fLane - fClr;
      const costL = Math.abs(cL - this.lane) + (cL <= LANE_MAX ? 0 : 20 + Math.abs(cL));
      const costR = Math.abs(cR - this.lane) + (cR >= -LANE_MAX ? 0 : 20 + Math.abs(cR));
      const best = costL < costR ? 1 : -1;
      if (this.avoidObj !== found || (best !== this.avoidSide && Math.abs(costL - costR) > 2.5)) this.avoidSide = best;
      this.avoidObj = found;
      this.avoidLane = clamp(fLane + this.avoidSide * fClr, -LANE_SAND, LANE_SAND);
      this.avoidHold = 0.5;
    } else if (this.avoidObj) {
      this.avoidHold -= dt;
      if (this.avoidHold <= 0) this.avoidObj = null;
    }
    const urgent = found && fAhead < Math.max(0, v - fVo) * 1.6;
    this.avoidW = damp(this.avoidW, this.avoidObj ? 1 : 0, this.avoidObj ? (urgent ? 5 : 2.5) : 0.9, dt);
    this.crowd = damp(this.crowd, crowd, crowd ? 4 : 1, dt);
  }

  // Трамплин впереди: чаще всего бот заходит на него ровно, чтобы прыгнуть
  _rampPlan(dt) {
    const ramps = this.sh.ramps, N = this.track.count, step = this.track.step;
    let best = null, bd = Infinity;
    for (let k = 0; k < ramps.length; k++) {
      let d = ramps[k].idx - this.s;
      if (d < -1.5) d += N;
      if (d < bd) { bd = d; best = ramps[k]; }
    }
    let tgt = 0;
    this.rampAim = false;
    if (best && bd * step < 110) {
      if (this.rampFor !== best) {
        this.rampFor = best;
        this.rampWant = Math.random() < 0.75;
        this.rampLane = best.lane + (Math.random() - 0.5) * Math.max(0, best.half - 2.5) * 2;
      }
      if (this.rampWant) tgt = 1;
      this.rampAim = this.rampWant && bd * step < 18 && bd * step > -4;
    }
    this.rampW = damp(this.rampW, tgt, tgt ? 1.4 : 0.8, dt);
  }

  // «Резинка» в гонке: далеко позади игрока — чуть быстрее, далеко впереди — чуть спокойнее
  _rubber(dt, player) {
    const tr = this.track, N = tr.count, P = tr.points;
    const x = player.pos.x, z = player.pos.z;
    let best = this.pIdx, bd = Infinity;
    this.pScan -= dt;
    const full = this.pIdx < 0 || (this.pScan < 0 && this.pDist > 25);
    if (full) {
      this.pScan = 1;
      for (let i = 0; i < N; i++) {
        const p = P[i], d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bd) { bd = d; best = i; }
      }
    } else {
      for (let k = -12; k <= 12; k++) {
        const i = (this.pIdx + k + N) % N;
        const p = P[i], d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (this.pIdx < 0) this.pLap = Math.round((this.lap * N + this.s - best) / N);
    else if (this.pIdx > N * 0.75 && best < N * 0.25) this.pLap++;
    else if (this.pIdx < N * 0.25 && best > N * 0.75) this.pLap--;
    this.pIdx = best;
    this.pDist = Math.sqrt(bd);
    const gap = (this.pLap * N + best - (this.lap * N + this.s)) * tr.step; // > 0 — игрок впереди
    const t = gap > 0 ? 1 + 0.08 * smoothstep(35, 260, gap) : 1 - 0.1 * smoothstep(35, 260, -gap);
    this.rubber = damp(this.rubber, t, 0.6, dt);
    return this.rubber;
  }

  // Столкновение «тремя кругами» вдоль кузова; удар делится между участниками
  _collide(o, isPlayer) {
    if (!o || !o.pos || !o.vel) return;
    const dx0 = o.pos.x - this.pos.x, dz0 = o.pos.z - this.pos.z;
    if (dx0 * dx0 + dz0 * dz0 > 49 || Math.abs(o.pos.y - this.pos.y) > 1.8) return;
    const sa = Math.sin(this.heading), ca = Math.cos(this.heading);
    const multi = Number.isFinite(o.heading);
    const sb = multi ? Math.sin(o.heading) : 0, cb = multi ? Math.cos(o.heading) : 1;
    const R = CR + (multi ? o.radius || CR : 1.6);
    let pen = 0, nx = 0, nz = 0, cx = 0, cz = 0;
    for (let i = 0; i < 3; i++) {
      const ax = this.pos.x + sa * CIRCLES[i], az = this.pos.z + ca * CIRCLES[i];
      for (let j = 0; j < (multi ? 3 : 1); j++) {
        const off = multi ? CIRCLES[j] : 0;
        const ddx = o.pos.x + sb * off - ax, ddz = o.pos.z + cb * off - az;
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2);
        if (R - d <= pen) continue;
        pen = R - d;
        if (d > 1e-4) { nx = ddx / d; nz = ddz / d; } else { nx = ca; nz = -sa; }
        cx = ax + nx * CR; cz = az + nz * CR;
      }
    }
    if (pen <= 0) return;
    const share = isPlayer ? 0.6 : 0.5;
    o.pos.x += nx * pen * share; o.pos.z += nz * pen * share;
    this.pos.x -= nx * pen * (1 - share); this.pos.z -= nz * pen * (1 - share);
    const rel = (o.vel.x - this.vel.x) * nx + (o.vel.z - this.vel.z) * nz;
    if (rel >= 0) return;
    const J = -rel * 1.3;
    const jo = J * share, jb = J * (1 - share);
    if (isPlayer) {
      o.vel.x += nx * jo; o.vel.z += nz * jo;
      if (o.yawRate !== undefined) {
        // закрутка от рычага точки удара относительно центра машины игрока
        const rx = cx - o.pos.x, rz = cz - o.pos.z;
        const rf = rx * sb + rz * cb, rl = rx * cb - rz * sb;
        const dvf = (nx * sb + nz * cb) * jo, dvl = (nx * cb - nz * sb) * jo;
        o.yawRate += clamp((rf * dvl - rl * dvf) * 0.25, -0.7, 0.7) + (Math.random() - 0.5) * 0.2;
      }
      if (o.events && (this.hitCd <= 0 || J > 5)) {
        o.events.push({ type: 'hit', strength: J, x: cx, z: cz });
        this.hitCd = 0.25;
      }
    } else o._kick(nx * jo, nz * jo, cx, cz);
    this._kick(-nx * jb, -nz * jb, cx, cz);
  }

  // Импульс от удара: продольная часть — в скорость, поперечная — в затухающий отброс, плюс закрутка кузова
  _kick(dvx, dvz, cx, cz) {
    const sp = Math.sin(this.psi), cp = Math.cos(this.psi);
    const along = dvx * sp + dvz * cp;
    this.speed = Math.max(0, this.speed + along);
    this.kx = clamp(this.kx + dvx - along * sp, -12, 12);
    this.kz = clamp(this.kz + dvz - along * cp, -12, 12);
    const sa = Math.sin(this.heading), ca = Math.cos(this.heading);
    const rx = cx - this.pos.x, rz = cz - this.pos.z;
    const rf = rx * sa + rz * ca, rl = rx * ca - rz * sa;
    const dvf = dvx * sa + dvz * ca, dvl = dvx * ca - dvz * sa;
    this.slideV += clamp((rf * dvl - rl * dvf) * 0.5, -2.5, 2.5);
    this.vel.x += dvx; this.vel.z += dvz;
  }

  _pose(dt) {
    const t = this.terrain;
    if (this.grounded) {
      t.getNormal(this.pos.x, this.pos.z, _n, 1.4);
      this.up.lerp(_n, 1 - Math.exp(-10 * dt)).normalize();
    } else {
      this.up.lerp(_n.set(0, 1, 0), 1 - Math.exp(-1 * dt)).normalize();
    }
    _z.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    _z.addScaledVector(this.up, -_z.dot(this.up)).normalize();
    _x.crossVectors(this.up, _z).normalize();
    _m.makeBasis(_x, this.up, _z);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.setFromRotationMatrix(_m);

    // Подвеска кузова: крен наружу в заносе, клевок при торможении, просадка при приземлении
    this.rollV += ((this.rollT - this.roll) * 90 - this.rollV * 11) * dt;
    this.pitchV += ((this.pitchT - this.pitch) * 90 - this.pitchV * 11) * dt;
    this.heaveV += (-this.heave * 140 - this.heaveV * 12) * dt;
    this.roll += this.rollV * dt;
    this.pitch += this.pitchV * dt;
    this.heave = clamp(this.heave + this.heaveV * dt, -0.25, 0.2);
    const body = this.model.body;
    body.position.y = this.heave;
    body.rotation.set(this.pitch, 0, this.roll);

    // Колёса: задние в заносе и на разгоне прокручиваются быстрее, передние — с контррулением
    const sp = this.speed / 0.42;
    this.spinF += sp * dt;
    this.spinR += sp * (1 + Math.abs(this.slide) * 1.2 + (this.accel > 4 ? 0.5 : 0)) * dt;
    const wr = this.model.wheelR;
    this.droop = damp(this.droop, this.grounded ? wr : wr - 0.14, 12, dt);
    for (const w of this.model.wheels) {
      w.spin.rotation.x = w.front ? this.spinF : this.spinR;
      w.pivot.position.y = this.droop;
      if (w.front) w.pivot.rotation.y = this.steer;
    }
    this.model.tailMat.emissiveIntensity = this.braking ? 3.5 : 0.6;
  }

  rearWheels(outA, outB) {
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    outA.set(this.pos.x - s * 1.4 + c * 0.9, this.pos.y, this.pos.z - c * 1.4 - s * 0.9);
    outB.set(this.pos.x - s * 1.4 - c * 0.9, this.pos.y, this.pos.z - c * 1.4 + s * 0.9);
  }

  progress() {
    return this.lap * this.track.count + this.s;
  }
}
