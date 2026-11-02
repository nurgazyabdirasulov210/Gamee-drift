// Эффекты колёс: следы, пылевые шлейфы, «петушиный хвост» песка в заносе, дым на трассе,
// пламя импульса, кольцевая ударная волна пыли при приземлении.
import { selectedMap } from './garage.js';
import * as THREE from 'three';
import { clamp } from './noise.js';
import { WIND } from './config.js';

// Цвета в линейном пространстве
const SAND = [0.74, 0.5, 0.29];
const SAND_LIGHT = [0.86, 0.66, 0.43];
const SAND_DARK = [0.59, 0.4, 0.23];      // песчинки и комья
const SMOKE = [0.78, 0.74, 0.7];
const FLAME = [4.2, 1.7, 0.5];            // HDR: ядро уходит в бело-жёлтый, блум подхватывает
const EXHAUST = [0.66, 0.6, 0.54];
const CHIP = [0.3, 0.2, 0.12];
// цвет пыли и песчинок зависит от карты (снег — белый, пепел — тёмный)
{
  const d = selectedMap().biome?.dust;
  if (d) for (let i = 0; i < 3; i++) { SAND[i] = d[i]; SAND_LIGHT[i] = Math.min(1, d[i] * 1.15 + 0.03); SAND_DARK[i] = d[i] * 0.8; CHIP[i] = d[i] * 0.45; }
}

// Параметры частиц — общие объекты, чтобы не выделять память на каждый выброс
const O_DUST = { drag: 1.3, grav: -0.06 };
const O_SPRAY = { drag: 2.0, grav: -0.05 };            // пыль «хвоста»: вылетает по дуге и зависает
const O_GRAIN = { drag: 0.6, grav: 1, kind: 1 };       // песчинки летят по баллистике
const O_SMOKE = { drag: 1.6, grav: -0.1 };
const O_FLAME = { drag: 3, grav: -0.3, kind: 2 };
const O_GLOW = { drag: 0, grav: 0, kind: 2 };
const O_EXHAUST = { drag: 2.2, grav: -0.12 };
const O_RING = { drag: 3.2, grav: -0.03 };             // ударная волна: быстрый разлёт и остановка
const O_COLUMN = { drag: 1.4, grav: -0.07 };
const O_BURST = { drag: 1.5, grav: -0.05 };
const O_CHIP = { drag: 0.4, grav: 1, kind: 1 };
const O_AMBIENT = { drag: 0.5, grav: -0.02 };

const TAU = Math.PI * 2;
const rnd = Math.random;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _e = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Effects {
  constructor(particles, tracks, terrain) {
    this.p = particles;
    this.tracks = tracks;
    this.terrain = terrain;
    this.acc = new Float32Array(256);
    this.prev = new Map();
    this.botPrev = [];
    this.ambientAcc = 0;
  }

  // Сколько частиц выпустить в этом кадре при частоте rate (дробная часть копится)
  _n(key, rate, dt) {
    const a = this.acc[key] + rate * dt;
    const n = Math.floor(a);
    this.acc[key] = a - n;
    return n;
  }

  car(car, dt) {
    const P = this.p;
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const yr = car.yawRate || 0;
    const road = car.surfaceRoad;
    const sp = car.speed;
    for (let i = 0; i < 4; i++) {
      const w = car.wheels[i];
      const x = w.world.x, z = w.world.z, y = w.ground;
      let pv = this.prev.get(w);
      if (!pv) { pv = { x, z, on: false }; this.prev.set(w, pv); }
      const on = car.contact > 0.4;
      const slip = w.slipLat + w.slipLong;
      if (on && pv.on) {
        const groove = (0.45 + 0.4 * (1 - road)) * clamp(0.4 + sp / 20, 0.4, 1);
        const scuff = clamp((slip - 1.5) / 9, 0, 1) * (1 - road * 0.5);
        this.tracks.addSegment(pv.x, pv.z, x, z, 0.5 + scuff * 0.35, groove, scuff);
      }
      pv.x = x; pv.z = z; pv.on = on;
      if (!on) continue;

      const rear = i >= 2;
      const slipK = clamp((slip - 2) / 10, 0, 1.5);
      // Скорость пятна контакта (машина + вращение кузова) и её боковая часть
      const wx = w.x || 0, wz = w.z || 0;
      const wvx = car.vel.x + yr * (c * wz - s * wx);
      const wvz = car.vel.z + yr * (-s * wz - c * wx);
      const lat = wvx * c - wvz * s;
      // Куда летит песок: назад — от пробуксовки и газа, наружу — по боковому скольжению колеса
      const lon = w.slipLong * 0.5 + 1.5 + (rear ? (car.throttle || 0) * slipK * 3 : 0);
      const tx = -s * lon + c * lat * 0.6, tz = -c * lon - s * lat * 0.6;
      const tl = Math.hypot(tx, tz) || 1;
      const ux = tx / tl, uz = tz / tl;
      const throwV = Math.min(tl, 16);

      // Пыль позади колёс (большие клубы в заносе — выносит по направлению выброса)
      const rate = ((sp > 1.5 ? sp * 0.45 : 0) + slipK * 38) * (rear ? 1 : 0.45) * (1 - road * 0.55);
      const nd = this._n(i, rate, dt);
      const big = slipK > 0.3;
      for (let e = 0; e < nd; e++) {
        const life = big ? 2.6 + rnd() * 2.2 : 1.4 + rnd() * 1.6;
        const col = rnd() < 0.5 ? SAND : SAND_LIGHT;
        const sh = 0.95 + rnd() * 0.1;
        const kick = big ? slipK * throwV * (0.08 + rnd() * 0.2) : 0;
        P.emit(
          x + (rnd() - 0.5) * 0.6, y + 0.25, z + (rnd() - 0.5) * 0.6,
          -car.vel.x * 0.12 + (rnd() - 0.5) * 2.5 + ux * kick,
          0.6 + rnd() * (1.5 + slipK * 2.5),
          -car.vel.z * 0.12 + (rnd() - 0.5) * 2.5 + uz * kick,
          0.7 + rnd() * 0.6, big ? 5 + rnd() * 5 : 2.2 + rnd() * 2.5,
          life, big ? 0.55 : 0.32,
          col[0] * sh, col[1] * sh, col[2] * sh, O_DUST,
        );
      }

      // «Петушиный хвост»: дуга песчинок и комьев + пыльная вуаль вдоль неё
      if (slipK > 0.15 && road < 0.6) {
        const sand = 1 - road;
        const ng = this._n(8 + i, slipK * 70 * (rear ? 1 : 0.3) * sand, dt);
        for (let e = 0; e < ng; e++) {
          const v = throwV * (0.55 + rnd() * 0.6);
          const sa = (rnd() - 0.5) * 0.6; // раствор конуса
          const cs = Math.cos(sa), sn = Math.sin(sa);
          const dx = ux * cs - uz * sn, dz = ux * sn + uz * cs;
          const clump = rnd() < 0.15;
          const sh = 0.8 + rnd() * 0.3;
          P.emit(x, y + 0.15, z,
            -car.vel.x * 0.2 + dx * v + (rnd() - 0.5) * 1.2,
            2.5 + rnd() * 4.5 + slipK * 1.5,
            -car.vel.z * 0.2 + dz * v + (rnd() - 0.5) * 1.2,
            clump ? 0.22 + rnd() * 0.12 : 0.11 + rnd() * 0.1, clump ? 0.25 : 0.1,
            0.7 + rnd() * 0.5, 0.85,
            SAND_DARK[0] * sh, SAND_DARK[1] * sh, SAND_DARK[2] * sh, O_GRAIN);
        }
        const ns = this._n(20 + i, slipK * (rear ? 10 : 3) * sand, dt);
        for (let e = 0; e < ns; e++) {
          const v = throwV * (0.35 + rnd() * 0.35);
          P.emit(x + (rnd() - 0.5) * 0.4, y + 0.3, z + (rnd() - 0.5) * 0.4,
            -car.vel.x * 0.15 + ux * v + (rnd() - 0.5) * 1.5,
            1.2 + rnd() * 2.2,
            -car.vel.z * 0.15 + uz * v + (rnd() - 0.5) * 1.5,
            0.5 + rnd() * 0.4, 2.5 + rnd() * 2.5, 1.0 + rnd() * 0.9, 0.28,
            SAND[0], SAND[1], SAND[2], O_SPRAY);
        }
      }
      // Шинный дым на укатанной трассе
      if (road > 0.5 && slipK > 0.25) {
        const nsm = this._n(16 + i, slipK * 30, dt);
        for (let e = 0; e < nsm; e++) {
          P.emit(x, y + 0.3, z, (rnd() - 0.5) * 1.5, 0.8 + rnd(), (rnd() - 0.5) * 1.5,
            0.8, 4 + rnd() * 3, 2.5 + rnd() * 1.5, 0.35, SMOKE[0], SMOKE[1], SMOKE[2], O_SMOKE);
        }
      }
    }
    // Импульс: короткое горячее пламя из выхлопа (аддитивное) и лёгкая дымка за ним
    if (car.boosting) this._flame(car, s, c, dt);
  }

  _flame(car, s, c, dt, kb = 0) {
    const P = this.p;
    const m = car.mesh?.matrixWorld;
    if (m) {
      _e.set(0.55, 0.5, -2.45).applyMatrix4(m);
      _d.set(0, 0.06, -1).transformDirection(m);
    } else {
      _e.set(car.pos.x - s * 2.45 + c * 0.55, car.pos.y + 0.5, car.pos.z - c * 2.45 - s * 0.55);
      _d.set(-s, 0.06, -c).normalize();
    }
    const vx = car.vel.x, vy = car.vel.y, vz = car.vel.z;
    // раскалённое ядро у среза трубы: живёт пару кадров и едет вместе с машиной
    const ng = this._n(33 + kb, 60, dt);
    for (let e = 0; e < ng; e++) {
      P.emit(_e.x + _d.x * 0.15, _e.y + _d.y * 0.15, _e.z + _d.z * 0.15, vx, vy, vz,
        0.8 + rnd() * 0.15, 0.05, 0.04, 1, FLAME[0], FLAME[1], FLAME[2], O_GLOW);
    }
    // языки пламени: быстрые, короткоживущие, вытягиваются по скорости
    const nf = this._n(30 + kb, 150, dt);
    for (let e = 0; e < nf; e++) {
      const v = 13 + rnd() * 5;
      const off = rnd() * 0.3;
      P.emit(_e.x + _d.x * off, _e.y + _d.y * off, _e.z + _d.z * off,
        vx + _d.x * v + (rnd() - 0.5) * 0.8, vy + _d.y * v + 0.3 + (rnd() - 0.5) * 0.4, vz + _d.z * v + (rnd() - 0.5) * 0.8,
        0.42 + rnd() * 0.12, 0.7, 0.1 + rnd() * 0.08, 0.9, FLAME[0], FLAME[1], FLAME[2], O_FLAME);
    }
    // горячий воздух с лёгкой дымкой за пламенем
    const nx = this._n(31 + kb, 18, dt);
    for (let e = 0; e < nx; e++) {
      P.emit(_e.x + _d.x * 1.4, _e.y + _d.y * 1.4 + 0.1, _e.z + _d.z * 1.4,
        vx * 0.5 + _d.x * 4 + (rnd() - 0.5), 0.5 + rnd() * 0.6, vz * 0.5 + _d.z * 4 + (rnd() - 0.5),
        0.4, 2 + rnd() * 1.5, 0.6 + rnd() * 0.5, 0.07, EXHAUST[0], EXHAUST[1], EXHAUST[2], O_EXHAUST);
    }
  }

  bot(bot, dt, k) {
    const P = this.p;
    bot.rearWheels(_a, _b);
    let pv = this.botPrev[k];
    if (!pv) pv = this.botPrev[k] = [{ x: _a.x, z: _a.z }, { x: _b.x, z: _b.z }];
    const slide = Math.abs(bot.slide);
    const s = Math.sin(bot.heading), c = Math.cos(bot.heading);
    const lat = bot.vel.x * c - bot.vel.z * s;
    const lon = 2 + bot.speed * 0.08;
    const tx = -s * lon + c * lat * 0.6, tz = -c * lon - s * lat * 0.6;
    const tl = Math.hypot(tx, tz) || 1;
    const ux = tx / tl, uz = tz / tl, throwV = Math.min(tl, 14);
    const big = slide > 0.25;
    for (let j = 0; j < 2; j++) {
      const w = j === 0 ? _a : _b;
      const y = this.terrain.getHeight(w.x, w.z);
      const p = pv[j];
      if (bot.grounded) this.tracks.addSegment(p.x, p.z, w.x, w.z, 0.55, 0.5, clamp(slide * 1.5, 0, 1));
      p.x = w.x; p.z = w.z;
      if (!bot.grounded) continue;
      const nd = this._n(40 + ((k * 2 + j) & 31), bot.speed * 0.4 + slide * 40, dt);
      for (let e = 0; e < nd; e++) {
        const kick = big ? slide * throwV * (0.2 + rnd() * 0.3) : 0;
        P.emit(w.x, y + 0.25, w.z,
          -bot.vel.x * 0.1 + (rnd() - 0.5) * 2 + ux * kick, 0.6 + rnd() * 1.5, -bot.vel.z * 0.1 + (rnd() - 0.5) * 2 + uz * kick,
          0.8, big ? 6 : 2.5, big ? 3.5 : 1.8, big ? 0.5 : 0.3, SAND[0], SAND[1], SAND[2], O_DUST);
      }
      // песчинки из-под задних колёс в заносе
      if (slide > 0.2) {
        const ng = this._n(80 + ((k * 2 + j) & 31), slide * 45, dt);
        for (let e = 0; e < ng; e++) {
          const v = throwV * (0.5 + rnd() * 0.6);
          const sh = 0.8 + rnd() * 0.3;
          P.emit(w.x, y + 0.15, w.z,
            -bot.vel.x * 0.2 + ux * v + (rnd() - 0.5) * 1.5, 2.5 + rnd() * 4, -bot.vel.z * 0.2 + uz * v + (rnd() - 0.5) * 1.5,
            0.1 + rnd() * 0.12, 0.12, 0.7 + rnd() * 0.4, 0.9,
            SAND_DARK[0] * sh, SAND_DARK[1] * sh, SAND_DARK[2] * sh, O_GRAIN);
        }
      }
    }
  }

  // Выброс пыли. ring — кольцевая ударная волна (по умолчанию для ударов о песок без обломков:
  // приземление, прыжок); иначе — облако во все стороны, как раньше.
  burst(x, y, z, n, power, color = SAND, chips = 0, chipColor = CHIP, ring = chips === 0) {
    const P = this.p;
    if (ring) this._ring(x, y, z, n, power, color);
    else {
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU;
        const r = power * (0.4 + rnd() * 0.6);
        P.emit(x + Math.cos(a) * 0.8, y + 0.3, z + Math.sin(a) * 0.8,
          Math.cos(a) * r, 0.8 + rnd() * power * 0.4, Math.sin(a) * r,
          1.0 + rnd(), 5 + rnd() * 5, 2.5 + rnd() * 2.5, 0.5, color[0], color[1], color[2], O_BURST);
      }
    }
    for (let i = 0; i < chips; i++) {
      const a = rnd() * TAU, r = 2 + rnd() * power;
      P.emit(x, y + 0.5, z, Math.cos(a) * r, 3 + rnd() * 5, Math.sin(a) * r,
        0.12 + rnd() * 0.14, 0, 1.2 + rnd(), 1, chipColor[0], chipColor[1], chipColor[2], O_CHIP);
    }
  }

  // Ударная волна: вал пыли разбегается кольцом по песку и зависает, в центре — поднимающийся столб,
  // во все стороны — брызги песчинок
  _ring(x, y, z, n, power, color) {
    const P = this.p;
    const nr = Math.max(6, Math.round(n * 0.7));
    const a0 = rnd() * TAU;
    for (let i = 0; i < nr; i++) {
      const a = a0 + (i + (rnd() - 0.5) * 0.6) * TAU / nr;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r0 = 1.3 + rnd() * 0.7;
      const v = power * (1.7 + rnd() * 0.8);
      const sh = 0.92 + rnd() * 0.12;
      P.emit(x + ca * r0, y + 0.15, z + sa * r0,
        ca * v, 0.25 + rnd() * 0.7, sa * v,
        1.0 + rnd() * 0.6, 3.5 + rnd() * 3 + power * 0.35, 1.8 + rnd() * 1.4, 0.58,
        color[0] * sh, color[1] * sh, color[2] * sh, O_RING);
    }
    for (let i = nr; i < n; i++) {
      const a = rnd() * TAU, r = rnd() * 1.2;
      const ca = Math.cos(a), sa = Math.sin(a);
      P.emit(x + ca * r, y + 0.3, z + sa * r,
        ca * 1.2, 1.2 + rnd() * power * 0.35, sa * 1.2,
        1.2 + rnd() * 0.6, 5 + rnd() * 4, 2.4 + rnd() * 2.2, 0.5,
        color[0], color[1], color[2], O_COLUMN);
    }
    const ng = Math.round(n * 0.7);
    for (let i = 0; i < ng; i++) {
      const a = rnd() * TAU, v = power * (0.6 + rnd() * 0.8);
      const ca = Math.cos(a), sa = Math.sin(a);
      const sh = 0.75 + rnd() * 0.3;
      P.emit(x + ca * 1.2, y + 0.2, z + sa * 1.2,
        ca * v, 2 + rnd() * power * 0.5, sa * v,
        0.1 + rnd() * 0.12, 0.15, 0.6 + rnd() * 0.5, 0.9,
        SAND_DARK[0] * sh, SAND_DARK[1] * sh, SAND_DARK[2] * sh, O_GRAIN);
    }
  }

  // Сдуваемые ветром песчаные вихри вокруг игрока
  ambient(center, dt) {
    this.ambientAcc += dt * 7;
    while (this.ambientAcc >= 1) {
      this.ambientAcc -= 1;
      const a = rnd() * TAU, r = 15 + rnd() * 70;
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      const y = this.terrain.gridHeight(x, z);
      this.p.emit(x, y + 0.2, z, WIND.x * WIND.strength * 2, 0.2, WIND.z * WIND.strength * 2,
        2.5, 8 + rnd() * 6, 4 + rnd() * 3, 0.12, SAND_LIGHT[0], SAND_LIGHT[1], SAND_LIGHT[2], O_AMBIENT);
    }
  }
}
