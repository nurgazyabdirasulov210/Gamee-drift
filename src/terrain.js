// Процедурная пустыня: барханы, сглаженная трасса, лагерь, шейдер песка.
import { selectedMap } from './garage.js';
import * as THREE from 'three';
import { WORLD_SIZE, HALF, QUALITY, WIND } from './config.js';
import { smoothstep, lerp, clamp } from './noise.js';
import { SAND_COMMON, SAND_FRAGMENT_COLOR, SAND_FRAGMENT_NORMAL, SAND_FRAGMENT_EMISSIVE } from './shaders/sand.js';

const MAPDEF = selectedMap();
const SAND = MAPDEF.sand;
const BIO = MAPDEF.biome || {};

export class Terrain {
  constructor(noise, track) {
    this.noise = noise;
    this.track = track;
    const res = QUALITY.grid;
    this.res = res;
    this.n = res + 1;
    this.cell = WORLD_SIZE / res;
    this.ramps = [];

    const n = this.n;
    this.heights = new Float32Array(n * n);
    this.trackDist = new Float32Array(n * n).fill(1e4);
    const trackH = new Float32Array(n * n);

    // 1) Высотный профиль трассы: сглаженные барханы
    const pts = track.points;
    let prof = pts.map((p) => this.rawHeight(p.x, p.z));
    for (let pass = 0; pass < 3; pass++) {
      const W = 24, out = new Array(prof.length);
      for (let i = 0; i < prof.length; i++) {
        let s = 0;
        for (let k = -W; k <= W; k++) s += prof[(i + k + prof.length) % prof.length];
        out[i] = s / (2 * W + 1);
      }
      prof = out;
    }
    for (let i = 0; i < pts.length; i++) track.heights[i] = prof[i] * 0.7 + 0.6;

    // 2) Растеризация расстояния до трассы
    const R = 44;
    const cell = this.cell;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      const ha = track.heights[k], hb = track.heights[(k + 1) % pts.length];
      const minX = Math.min(a.x, b.x) - R, maxX = Math.max(a.x, b.x) + R;
      const minZ = Math.min(a.z, b.z) - R, maxZ = Math.max(a.z, b.z) + R;
      const i0 = Math.max(0, Math.floor((minX + HALF) / cell)), i1 = Math.min(res, Math.ceil((maxX + HALF) / cell));
      const j0 = Math.max(0, Math.floor((minZ + HALF) / cell)), j1 = Math.min(res, Math.ceil((maxZ + HALF) / cell));
      const abx = b.x - a.x, abz = b.z - a.z, ab2 = abx * abx + abz * abz || 1;
      for (let j = j0; j <= j1; j++) {
        const z = -HALF + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = -HALF + i * cell;
          let t = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
          t = clamp(t, 0, 1);
          const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
          const d = Math.sqrt(dx * dx + dz * dz);
          const idx = j * n + i;
          if (d < this.trackDist[idx]) {
            this.trackDist[idx] = d;
            trackH[idx] = ha + (hb - ha) * t;
          }
        }
      }
    }

    // 3) Итоговые высоты
    let campSum = 0, campCnt = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      campSum += this.rawHeight(Math.cos(ang) * 70, Math.sin(ang) * 70); campCnt++;
    }
    this.campHeight = (campSum / campCnt) * 0.6;
    const hw = track.width / 2;

    // Впадины: дрифт-чаша (как в видео) и оазис с прудом
    this.sites = [];
    const pick = (r, minCamp) => {
      for (let k = 0; k < 400; k++) {
        const a = k * 2.399, rr = minCamp + ((k * 37) % 23) / 23 * (HALF - 160 - r - minCamp);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        if (this.trackDistanceAt(x, z) < r * 1.7 + hw + 10) continue;
        if (this.sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.r * 2 + r * 2 + 60)) continue;
        let sum = 0;
        for (let q = 0; q < 12; q++) sum += this.rawHeight(x + Math.cos(q) * r * 1.4, z + Math.sin(q) * r * 1.4);
        return { x, z, base: sum / 12 };
      }
      return null;
    };
    const bowl = pick(55, 200);
    if (bowl) this.sites.push((this.bowl = { ...bowl, type: 'bowl', r: 55, depth: 8 }));
    const oasis = pick(28, 180);
    if (oasis) this.sites.push((this.oasis = { ...oasis, type: 'oasis', r: 28, depth: 3.2, lake: BIO.lake || 'oasis' }));
    if (this.oasis) this.oasis.water = this.oasis.base - this.oasis.depth * 0.62;

    for (let j = 0; j <= res; j++) {
      const z = -HALF + j * cell;
      for (let i = 0; i <= res; i++) {
        const x = -HALF + i * cell;
        const idx = j * n + i;
        let h = this.rawHeight(x, z);
        const d = this.trackDist[idx];
        const w = 1 - smoothstep(hw + 1, hw + 30, d);
        h = lerp(h, trackH[idx] + (d < hw ? 0 : 0.25 * smoothstep(hw, hw + 6, d)), w);
        const dc = Math.hypot(x, z);
        h = lerp(h, this.campHeight + 0.6 * this.noise.noise(x * 0.02, z * 0.02), 1 - smoothstep(70, 150, dc));
        for (const st of this.sites) {
          const dd = Math.hypot(x - st.x, z - st.z) / st.r;
          if (dd > 2.2) continue;
          h = lerp(h, st.base, 1 - smoothstep(1.3, 2.2, dd));
          if (dd < 1) { const q = 1 - dd * dd; h -= st.depth * q * (0.6 + 0.4 * q); }
          else if (st.type === 'bowl') h += 0.9 * Math.sin(Math.min(1, (dd - 1) / 0.3) * Math.PI) * (dd < 1.3 ? 1 : 0);
        }
        const e = smoothstep(HALF - 140, HALF - 10, Math.max(Math.abs(x), Math.abs(z)));
        h += e * e * 70;
        this.heights[idx] = h;
      }
    }

    // Маска трассы / лагеря для шейдера (R — укатанная колея, G — лагерь, B — обочина)
    const mask = new Uint8Array(n * n * 4);
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        const idx = j * n + i;
        const x = -HALF + i * cell, z = -HALF + j * cell;
        const d = this.trackDist[idx];
        mask[idx * 4] = 255 * (1 - smoothstep(hw - 2, hw + 2.5, d));
        mask[idx * 4 + 1] = 255 * (1 - smoothstep(35, 85, Math.hypot(x, z)));
        mask[idx * 4 + 2] = 255 * (smoothstep(hw - 1, hw + 2, d) * (1 - smoothstep(hw + 2, hw + 7, d)));
        mask[idx * 4 + 3] = 255;
      }
    }
    this.maskTex = new THREE.DataTexture(mask, n, n, THREE.RGBAFormat);
    this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.minFilter = THREE.LinearFilter;
    this.maskTex.wrapS = this.maskTex.wrapT = THREE.ClampToEdgeWrapping;
    this.maskTex.needsUpdate = true;
  }

  // «Сырые» барханы: асимметричные гребни поперёк ветра + крупные волны
  rawHeight(x, z) {
    const nz = this.noise;
    const wx = x + 70 * nz.noise(x * 0.0021, z * 0.0021);
    const wz = z + 70 * nz.noise(x * 0.0021 + 31.7, z * 0.0021 + 17.3);
    const ang = Math.atan2(WIND.z, WIND.x);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const u = wx * ca + wz * sa;
    const v = -wx * sa + wz * ca;
    const phase = u / 150 + 0.7 * nz.noise(v * 0.0045, 3.3) + 0.25 * nz.noise(v * 0.012, 7.7);
    const f = phase - Math.floor(phase);
    const ss = (t) => t * t * (3 - 2 * t);
    const prof = f < 0.72 ? ss(f / 0.72) : 1 - ss((f - 0.72) / 0.28);
    const amp = 15 * (0.35 + 0.65 * (nz.noise(x * 0.0016 + 4, z * 0.0016 - 2) * 0.5 + 0.5));
    let h = prof * amp * (BIO.dune ?? 1);
    h += 16 * (BIO.hills ?? 1) * nz.fbm(x * 0.0011, z * 0.0011, 3);
    h += 2.2 * nz.noise(x * 0.011, z * 0.011);
    h += 0.5 * nz.noise(x * 0.04, z * 0.04);
    if (BIO.terrace) {
      // ступенчатые плато каньона
      const t = BIO.terrace, k = h / t, f = k - Math.floor(k);
      h = (Math.floor(k) + smoothstep(0.5, 0.88, f)) * t;
    }
    return h;
  }

  // Билинейная выборка сетки
  gridHeight(x, z) {
    const res = this.res, n = this.n;
    let fx = (x + HALF) / this.cell, fz = (z + HALF) / this.cell;
    fx = clamp(fx, 0, res - 1e-4); fz = clamp(fz, 0, res - 1e-4);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const h = this.heights;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  // Высота с учётом трамплинов
  getHeight(x, z) {
    let h = this.gridHeight(x, z);
    for (let k = 0; k < this.ramps.length; k++) {
      const r = this.ramps[k];
      const dx = x - r.x, dz = z - r.z;
      if (dx * dx + dz * dz > r.bound2) continue;
      const u = dx * r.dx + dz * r.dz;
      const v = -dx * r.dz + dz * r.dx;
      if (Math.abs(v) > r.width / 2 || u < -r.length / 2 || u > r.length / 2) continue;
      const rh = r.base + r.height * ((u + r.length / 2) / r.length);
      if (rh > h) h = rh;
    }
    return h;
  }

  getNormal(x, z, out = new THREE.Vector3(), e = 0.8) {
    const hl = this.getHeight(x - e, z), hr = this.getHeight(x + e, z);
    const hd = this.getHeight(x, z - e), hu = this.getHeight(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  // Насколько точка на укатанной трассе [0..1]
  roadAt(x, z) {
    const res = this.res, n = this.n;
    const fx = clamp((x + HALF) / this.cell, 0, res), fz = clamp((z + HALF) / this.cell, 0, res);
    const d = this.trackDist[Math.round(fz) * n + Math.round(fx)];
    return 1 - smoothstep(this.track.width / 2 - 1, this.track.width / 2 + 2, d);
  }

  trackDistanceAt(x, z) {
    const res = this.res, n = this.n;
    const fx = clamp((x + HALF) / this.cell, 0, res), fz = clamp((z + HALF) / this.cell, 0, res);
    return this.trackDist[Math.round(fz) * n + Math.round(fx)];
  }

  addRamp(x, z, angle, length, width, height) {
    const base = Math.min(
      this.gridHeight(x - Math.sin(angle) * length / 2, z - Math.cos(angle) * length / 2),
      this.gridHeight(x, z),
    ) - 0.05;
    const r = {
      x, z, angle, length, width, height, base,
      dx: Math.sin(angle), dz: Math.cos(angle),
      bound2: (length * length + width * width) / 4 + 1,
    };
    this.ramps.push(r);
    return r;
  }

  buildMesh(tireTracks) {
    const n = this.n, res = this.res, cell = this.cell;
    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const h = this.heights;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        pos[idx * 3] = -HALF + i * cell;
        pos[idx * 3 + 1] = h[idx];
        pos[idx * 3 + 2] = -HALF + j * cell;
        const hl = h[j * n + Math.max(0, i - 1)], hr = h[j * n + Math.min(res, i + 1)];
        const hd = h[Math.max(0, j - 1) * n + i], hu = h[Math.min(res, j + 1) * n + i];
        const nx = hl - hr, ny = 2 * cell, nz = hd - hu;
        const l = Math.hypot(nx, ny, nz);
        nor[idx * 3] = nx / l; nor[idx * 3 + 1] = ny / l; nor[idx * 3 + 2] = nz / l;
      }
    }
    const index = new Uint32Array(res * res * 6);
    let k = 0;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();

    const uniforms = {
      uMask: { value: this.maskTex },
      uTire: { value: tireTracks.texture },
      uTime: { value: 0 },
      uWorld: { value: WORLD_SIZE },
      uMaskScale: { value: 1 / (cell * n) },
      uMaskOffset: { value: (HALF / cell + 0.5) / n },
      uTireTexel: { value: 1 / tireTracks.res },
      uWind: { value: new THREE.Vector2(WIND.x, WIND.z) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSandA: { value: new THREE.Color(SAND[0]) },
      uSandB: { value: new THREE.Color(SAND[1]) },
      uSandC: { value: new THREE.Color(SAND[2]) },
      uRoad: { value: new THREE.Color(0xa87449) },
    };
    this.uniforms = uniforms;

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.0 });
    if (QUALITY.sandLow) mat.defines = { SAND_LOW: '' };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNormal;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * objectNormal);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + SAND_COMMON)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + SAND_FRAGMENT_COLOR)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = sandRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SAND_FRAGMENT_NORMAL)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + SAND_FRAGMENT_EMISSIVE);
    };
    mat.customProgramCacheKey = () => (QUALITY.sandLow ? 'sand-low' : 'sand-v1');

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;
    return mesh;
  }
}
