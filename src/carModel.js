// Процедурная модель пикапа-внедорожника: кузов, стёкла, колёса, фары, дуга безопасности.
// Для скорости на телефоне все статичные детали слиты в несколько мешей по материалам:
// краска, стекло, «палитра» (всё тёмное/металл/резина одной текстурой-палитрой), фары, фонари.
// Геометрия строится один раз и общая для всех машин; материалы краски и фонарей — свои у каждой.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Палитра: цвет (sRGB), шероховатость, металличность. Одна текстура → один материал на все детали.
const PAL = {
  trim: [0x1d1f22, 0.75, 0.1],     // чёрный пластик, бамперы, расширители
  chrome: [0xc8ccd2, 0.18, 1.0],
  rubber: [0x1a1a1a, 0.95, 0],
  rim: [0x8d939a, 0.32, 0.85],
  rimDark: [0x2b2e33, 0.5, 0.6],
  liner: [0x25272a, 0.9, 0],       // покрытие кузова, подкрылки
  plate: [0xf2efe6, 0.6, 0],
  seam: [0x0b0c0d, 0.85, 0],       // щели дверей, тёмные проёмы
  alu: [0xa3a8ad, 0.38, 0.8],      // рифлёные накладки ступеней
  red: [0xc0261c, 0.45, 0.1],      // буксировочные крюки, задние габариты
  lens: [0xe8ecef, 0.12, 0.1],     // прозрачные стёкла заднего хода
  mirror: [0x8fa4b8, 0.06, 1.0],
  amber: [0xe88a1c, 0.3, 0],       // боковые повторители
};
const PAL_KEYS = Object.keys(PAL);
const PAL_N = 16;
const palU = (key) => (PAL_KEYS.indexOf(key) + 0.5) / PAL_N;

const shared = {};
function sharedMats() {
  if (shared.ready) return shared;
  shared.glass = new THREE.MeshPhysicalMaterial({
    color: 0x10161b, metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6,
  });
  const col = new Uint8Array(PAL_N * 4), rm = new Uint8Array(PAL_N * 4);
  PAL_KEYS.forEach((k, i) => {
    const [hex, rough, metal] = PAL[k];
    col.set([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255], i * 4);
    rm.set([0, Math.round(rough * 255), Math.round(metal * 255), 255], i * 4); // G — шероховатость, B — металл
  });
  const tex = (data, cs) => {
    const t = new THREE.DataTexture(data, PAL_N, 1);
    t.colorSpace = cs;
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const rmTex = tex(rm, THREE.NoColorSpace);
  shared.pal = new THREE.MeshStandardMaterial({
    map: tex(col, THREE.SRGBColorSpace), roughnessMap: rmTex, metalnessMap: rmTex, roughness: 1, metalness: 1,
  });
  shared.ready = true;
  return shared;
}

// ---------- Утилиты геометрии ----------
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _up = new THREE.Vector3(0, 1, 0);

function xf(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return g.applyMatrix4(_m4.compose(_p.set(x, y, z), _q, _s));
}

function cylBetween(a, b, r, seg = 8) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1, true);
  _q.setFromUnitVectors(_up, d.normalize());
  return g.applyMatrix4(_m4.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s));
}

function tube(points, r, seg, radial = 8) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p))), seg, r, radial);
}

// Вывернуть грани внутрь (для подкрылков, видимых изнутри арки)
function flip(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
}

// Сглаженные нормали с порогом излома (для фасок и арок вместо «гранёного» вида)
function smoothNormals(g, angle) {
  const pos = g.attributes.position, n = pos.count;
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const faces = [], keys = [], buckets = new Map();
  for (let f = 0; f < n; f += 3) {
    a.fromBufferAttribute(pos, f); b.fromBufferAttribute(pos, f + 1); c.fromBufferAttribute(pos, f + 2);
    const fn = new THREE.Vector3().subVectors(c, b).cross(a.sub(b)).normalize();
    faces.push(fn);
    for (let k = 0; k < 3; k++) {
      const h = key(f + k);
      keys.push(h);
      let arr = buckets.get(h);
      if (!arr) buckets.set(h, (arr = []));
      arr.push(fn);
    }
  }
  const cos = Math.cos(angle), out = new Float32Array(n * 3), t = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const fn = faces[(i / 3) | 0];
    t.set(0, 0, 0);
    for (const o of buckets.get(keys[i])) if (fn.dot(o) > cos) t.add(o);
    if (t.lengthSq() < 1e-12) t.copy(fn);
    t.normalize();
    out[i * 3] = t.x; out[i * 3 + 1] = t.y; out[i * 3 + 2] = t.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

// Выдавленная деталь: торцы (группа 0) остаются плоскими, боковины и фаски (группа 1) сглаживаются
function smoothExtrude(g, angle) {
  const pos = g.attributes.position.array;
  const parts = g.groups.map((gr) => {
    const p = new THREE.BufferGeometry();
    p.setAttribute('position', new THREE.BufferAttribute(pos.slice(gr.start * 3, (gr.start + gr.count) * 3), 3));
    if (gr.materialIndex === 1) smoothNormals(p, angle); else p.computeVertexNormals();
    return p;
  });
  return mergeGeometries(parts);
}

function extrudeSide(shape, depth, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 14,
  });
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  return smoothExtrude(g, 0.62);
}

// Скруглённый брусок w×h×d с фаской b (центр в начале координат)
function slab(w, h, d, b) {
  const sh = new THREE.Shape();
  const hw = w / 2 - b, hd = d / 2 - b;
  sh.moveTo(-hw, -hd); sh.lineTo(hw, -hd); sh.lineTo(hw, hd); sh.lineTo(-hw, hd); sh.lineTo(-hw, -hd);
  const depth = Math.max(h - 2 * b, 0.001);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -depth / 2, 0);
  return smoothExtrude(g, 0.85);
}

// Набор деталей, раскладываемых по материалам и сливаемых в один меш на материал
class Kit {
  constructor() { this.parts = { paint: [], glass: [], head: [], tail: [], pal: [] }; }

  add(key, g) {
    if (g.index) g = g.toNonIndexed();
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.getAttribute('position'));
    out.setAttribute('normal', g.getAttribute('normal'));
    if (key in PAL) {
      const uv = new Float32Array(out.attributes.position.count * 2);
      const u = palU(key);
      for (let i = 0; i < uv.length; i += 2) { uv[i] = u; uv[i + 1] = 0.5; }
      out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      this.parts.pal.push(out);
    } else if (key === 'palRaw') {
      out.setAttribute('uv', g.getAttribute('uv'));
      this.parts.pal.push(out);
    } else {
      this.parts[key].push(out);
    }
  }

  box(key, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
    this.add(key, xf(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz));
  }

  build() {
    const res = {};
    for (const k in this.parts) {
      if (!this.parts[k].length) continue;
      const g = mergeVertices(mergeGeometries(this.parts[k]));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      res[k] = g;
    }
    return res;
  }
}

// ---------- Колесо ----------
const wheelCache = new Map();

function wheelGeometry(radius, width, side) {
  const key = `${radius}|${width}|${side}`;
  if (wheelCache.has(key)) return wheelCache.get(key);
  const K = new Kit();
  const hw = width / 2;

  // Шина
  const prof = [
    [radius * 0.64, -hw * 0.95], [radius * 0.93, -hw], [radius * 0.99, -hw * 0.75],
    [radius, -hw * 0.3], [radius, hw * 0.3], [radius * 0.99, hw * 0.75], [radius * 0.93, hw], [radius * 0.64, hw * 0.95],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  K.add('rubber', new THREE.LatheGeometry(prof, 28).rotateZ(Math.PI / 2));

  // Протектор: шашки по окружности в шахматном порядке
  const ax = new THREE.Vector3(1, 0, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3();
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const off = (i % 2 ? 1 : -1) * width * 0.22;
    p.set(off, Math.cos(a) * (radius + 0.004), Math.sin(a) * (radius + 0.004));
    q.setFromAxisAngle(ax, a);
    K.add('rubber', new THREE.BoxGeometry(width * 0.42, 0.055, 0.11).applyMatrix4(m.compose(p, q, _s)));
  }
  // Грунтозацепы на внешней боковине
  for (let i = 0; i < 18; i++) {
    const a = ((i + 0.5) / 18) * Math.PI * 2;
    const r = radius * (i % 2 ? 0.86 : 0.9);
    p.set(side * (hw * 0.985 + 0.004), Math.cos(a) * r, Math.sin(a) * r);
    q.setFromAxisAngle(ax, a);
    K.add('rubber', new THREE.BoxGeometry(0.022, radius * 0.13, 0.075).applyMatrix4(m.compose(p, q, _s)));
  }

  // Диск: обод, лицевая часть, спицы, ступица, кольцо бедлока с болтами, гайки
  K.add('rimDark', new THREE.CylinderGeometry(radius * 0.64, radius * 0.64, width * 0.86, 22, 1, true).rotateZ(Math.PI / 2));
  K.add('rimDark', xf(new THREE.CircleGeometry(radius * 0.63, 22), side * width * 0.3, 0, 0, 0, side * Math.PI / 2));
  for (let i = 0; i < 6; i++) K.box('rim', 0.05, radius * 1.18, 0.07, side * width * 0.36, 0, 0, (i / 6) * Math.PI);
  K.add('chrome', xf(new THREE.CylinderGeometry(0.075, 0.09, 0.08, 12), side * width * 0.42, 0, 0, 0, 0, -side * Math.PI / 2));
  K.add('rim', xf(new THREE.TorusGeometry(radius * 0.63, 0.018, 4, 24), side * width * 0.4, 0, 0, 0, Math.PI / 2));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    K.box('chrome', 0.018, 0.018, 0.018, side * (width * 0.4 + 0.016), Math.cos(a) * radius * 0.63, Math.sin(a) * radius * 0.63, a);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    K.add('chrome', xf(new THREE.CylinderGeometry(0.016, 0.016, 0.028, 6), side * (width * 0.36 + 0.038), Math.cos(a) * 0.125, Math.sin(a) * 0.125, 0, 0, Math.PI / 2));
  }

  const g = K.build().pal;
  wheelCache.set(key, g);
  return g;
}

export function buildWheel(radius = 0.42, width = 0.33, side = 1) {
  const spin = new THREE.Group();
  const mesh = new THREE.Mesh(wheelGeometry(radius, width, side), sharedMats().pal);
  mesh.castShadow = true;
  spin.add(mesh);
  return spin;
}

// ---------- Кузов (общая геометрия для всех машин) ----------
let bodyGeo = null;

function bodyGeometry() {
  if (bodyGeo) return bodyGeo;
  const K = new Kit();
  const BED = 0.92; // пол кузова-платформы (ниже линии борта)

  // --- Нижняя часть кузова (боковой профиль) с углублением под платформу ---
  const s = new THREE.Shape();
  s.moveTo(-2.25, 0.52);
  s.lineTo(-2.25, BED);
  s.lineTo(-0.6, BED);
  s.lineTo(-0.6, 1.11);
  s.lineTo(1.18, 1.12);
  s.lineTo(2.08, 1.0);
  s.quadraticCurveTo(2.3, 0.97, 2.31, 0.78);
  s.lineTo(2.3, 0.48);
  s.lineTo(1.98, 0.42);
  s.absarc(1.4, 0.44, 0.57, 0, Math.PI, false);
  s.lineTo(-0.83, 0.42);
  s.absarc(-1.4, 0.44, 0.57, 0, Math.PI, false);
  s.lineTo(-2.25, 0.52);
  K.add('paint', extrudeSide(s, 1.84, 0.06));

  // Борта и задний борт платформы: П-образная стенка, выдавленная вверх
  {
    const ox = 0.9615, ix = 0.88, rz = 2.2915, iz = 2.21, fz = 0.6, cr = 0.04;
    const u = new THREE.Shape(); // координаты (x, −z)
    u.moveTo(-ox, fz);
    u.lineTo(-ox, rz - cr);
    u.absarc(-ox + cr, rz - cr, cr, Math.PI, Math.PI / 2, true);
    u.lineTo(ox - cr, rz);
    u.absarc(ox - cr, rz - cr, cr, Math.PI / 2, 0, true);
    u.lineTo(ox, fz);
    u.lineTo(ix, fz);
    u.lineTo(ix, iz);
    u.lineTo(-ix, iz);
    u.lineTo(-ix, fz);
    u.lineTo(-ox, fz);
    const g = new THREE.ExtrudeGeometry(u, {
      depth: 0.24, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2, curveSegments: 4,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.9, 0);
    K.add('paint', smoothExtrude(g, 0.85));
  }

  // --- Кабина-стекло ---
  const gs = new THREE.Shape();
  gs.moveTo(-0.62, 1.12);
  gs.lineTo(-0.55, 1.7);
  gs.quadraticCurveTo(-0.5, 1.76, -0.4, 1.76);
  gs.lineTo(0.42, 1.76);
  gs.quadraticCurveTo(0.56, 1.75, 0.62, 1.68);
  gs.lineTo(1.2, 1.12);
  gs.lineTo(-0.62, 1.12);
  K.add('glass', extrudeSide(gs, 1.6, 0.04));
  // Крыша (окрашенная)
  const r = new THREE.Shape();
  r.moveTo(-0.6, 1.72);
  r.quadraticCurveTo(-0.55, 1.8, -0.42, 1.8);
  r.lineTo(0.44, 1.8);
  r.quadraticCurveTo(0.58, 1.79, 0.64, 1.71);
  r.lineTo(-0.6, 1.72);
  K.add('paint', extrudeSide(r, 1.66, 0.03));

  for (const sx of [-1, 1]) {
    // Стойки
    K.box('paint', 0.06, 0.66, 0.1, sx * 0.83, 1.43, 0.93, -0.86);
    K.box('paint', 0.06, 0.62, 0.12, sx * 0.83, 1.42, -0.59, 0.12);
    // Чёрная средняя стойка на стекле и уплотнитель по линии окон
    K.box('trim', 0.012, 0.6, 0.075, sx * 0.846, 1.43, 0.04);
    K.box('trim', 0.06, 0.03, 1.78, sx * 0.87, 1.18, 0.29);
    // Щели дверей (передняя, средняя, задняя дверь) и зазор кабина/платформа
    for (const z of [0.7, 0.04, -0.55, -0.68]) K.box('seam', 0.006, 0.6, 0.012, sx * 0.982, 0.79, z);
    // Ручки дверей
    for (const z of [0.15, -0.47]) K.box('trim', 0.022, 0.035, 0.13, sx * 0.99, 0.98, z);
    // Зеркала: корпус, кронштейн, стекло
    K.box('paint', 0.2, 0.13, 0.08, sx * 1.04, 1.25, 0.95);
    K.box('trim', 0.12, 0.035, 0.05, sx * 0.94, 1.2, 0.97);
    K.box('mirror', 0.17, 0.1, 0.006, sx * 1.045, 1.25, 0.908);
    // Боковые повторители: жёлтые спереди, красные сзади
    K.box('amber', 0.01, 0.04, 0.09, sx * 0.983, 0.85, 2.13);
    K.box('red', 0.01, 0.04, 0.09, sx * 0.985, 0.95, -2.12);
    // Подножки с алюминиевой накладкой
    K.add('trim', xf(slab(0.16, 0.05, 1.6, 0.015), sx * 1.02, 0.42, 0));
    K.box('alu', 0.12, 0.008, 1.5, sx * 1.025, 0.447, 0);
    for (const z of [-0.5, 0.5]) K.box('trim', 0.1, 0.07, 0.06, sx * 0.96, 0.42, z);
    // Брызговики
    K.box('trim', 0.3, 0.26, 0.02, sx * 0.86, 0.32, -1.98);
    for (const az of [1.4, -1.4]) {
      // Расширители арок
      K.add('trim', xf(new THREE.TorusGeometry(0.6, 0.06, 6, 18, Math.PI), sx * 0.98, 0.44, az, 0, Math.PI / 2));
    }
  }
  // Подкрылки: тёмная внутренняя поверхность арок
  for (const az of [1.4, -1.4]) {
    K.add('liner', xf(flip(new THREE.CylinderGeometry(0.505, 0.505, 1.92, 12, 1, true, Math.PI, Math.PI)), 0, 0.44, az, 0, 0, -Math.PI / 2));
  }
  // Лючок бензобака (правый борт)
  K.add('seam', xf(new THREE.TorusGeometry(0.07, 0.005, 3, 16), -0.984, 1.02, -0.86, 0, Math.PI / 2));

  // --- Капот: выпуклость с воздухозаборниками, дворники ---
  const hoodTilt = 0.1326;
  K.add('paint', xf(slab(0.72, 0.05, 0.74, 0.02), 0, 1.131, 1.64, hoodTilt));
  for (const sx of [-1, 1]) K.box('seam', 0.14, 0.012, 0.2, sx * 0.19, 1.183, 1.45, hoodTilt);
  for (const x of [-0.3, 0.28]) K.box('trim', 0.46, 0.012, 0.022, x, 1.2, 1.18, 0.767);

  // --- Платформа: покрытие с рёбрами, окантовка бортов, запаска, дуга ---
  K.box('liner', 1.72, 0.03, 1.53, 0, 0.985, -1.43);
  for (let i = -4; i <= 4; i++) K.box('liner', 0.035, 0.014, 1.45, i * 0.16, 1.006, -1.43);
  for (const sx of [-1, 1]) {
    K.box('trim', 0.135, 0.03, 1.66, sx * 0.9175, 1.168, -1.49);
    for (const z of [-0.95, -2.0]) K.box('seam', 0.06, 0.004, 0.045, sx * 0.92, 1.185, z);
  }
  K.box('trim', 1.97, 0.03, 0.13, 0, 1.168, -2.255);
  // Запаска лёжа в кузове
  K.add('palRaw', xf(wheelGeometry(0.36, 0.26, 1).clone(), 0, 1.145, -1.55, 0, 0, Math.PI / 2));
  // Дуга безопасности с распорками к бортам
  K.add('trim', tube([[-0.9, 1.17, -0.71], [-0.83, 1.9, -0.72], [0, 1.97, -0.72], [0.83, 1.9, -0.72], [0.9, 1.17, -0.71]], 0.045, 28));
  for (const sx of [-1, 1]) {
    K.add('trim', cylBetween(new THREE.Vector3(sx * 0.845, 1.84, -0.73), new THREE.Vector3(sx * 0.92, 1.18, -1.28), 0.032));
    K.box('trim', 0.14, 0.02, 0.14, sx * 0.9, 1.19, -0.71);
    K.box('trim', 0.1, 0.02, 0.12, sx * 0.92, 1.19, -1.28);
  }

  // --- Крыша: люстра и багажник ---
  K.box('trim', 1.3, 0.09, 0.14, 0, 1.86, 0.3);
  for (let i = 0; i < 4; i++) K.box('head', 0.2, 0.06, 0.012, -0.45 + i * 0.3, 1.86, 0.372);
  for (const sx of [-1, 1]) {
    K.box('trim', 0.035, 0.03, 0.74, sx * 0.7, 1.89, -0.15);
    for (const z of [-0.44, 0.12]) K.box('trim', 0.035, 0.06, 0.05, sx * 0.7, 1.85, z);
  }
  for (const z of [-0.48, -0.12]) K.box('trim', 1.44, 0.03, 0.035, 0, 1.89, z);

  // --- Шноркель (правая стойка) ---
  K.add('trim', tube([[-0.93, 1.08, 1.21], [-0.955, 1.2, 1.15], [-0.94, 1.45, 0.92], [-0.925, 1.7, 0.68], [-0.92, 1.79, 0.6]], 0.045, 20));
  K.add('trim', xf(slab(0.11, 0.1, 0.2, 0.03), -0.92, 1.8, 0.67));
  K.box('seam', 0.08, 0.07, 0.006, -0.92, 1.8, 0.771);

  // --- Перед: бампер, кенгурятник, решётка, фары, противотуманки, крюки ---
  K.add('trim', xf(slab(2.02, 0.26, 0.26, 0.03), 0, 0.52, 2.3));
  K.box('seam', 1.0, 0.27, 0.07, 0, 0.76, 2.36);
  K.box('trim', 1.04, 0.035, 0.08, 0, 0.9, 2.36);
  K.box('trim', 1.04, 0.035, 0.08, 0, 0.625, 2.36);
  for (const sx of [-1, 1]) K.box('trim', 0.035, 0.3, 0.08, sx * 0.505, 0.76, 2.36);
  for (let i = 0; i < 4; i++) K.box('chrome', 0.94, 0.022, 0.015, 0, 0.68 + i * 0.055, 2.396);
  K.box('trim', 0.03, 0.24, 0.015, 0, 0.76, 2.398);
  for (const sx of [-1, 1]) {
    K.box('trim', 0.37, 0.15, 0.06, sx * 0.72, 0.85, 2.345);
    K.box('head', 0.32, 0.105, 0.02, sx * 0.72, 0.85, 2.38);
    K.add('trim', xf(new THREE.CylinderGeometry(0.068, 0.068, 0.02, 14), sx * 0.7, 0.55, 2.437, Math.PI / 2));
    K.add('head', xf(new THREE.CylinderGeometry(0.052, 0.052, 0.02, 14), sx * 0.7, 0.55, 2.443, Math.PI / 2));
    K.add('red', xf(new THREE.TorusGeometry(0.04, 0.013, 5, 10, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), sx * 0.52, 0.43, 2.43));
  }
  K.add('trim', tube([[-0.45, 0.64, 2.36], [-0.45, 0.9, 2.45], [-0.36, 1.0, 2.47], [0, 1.02, 2.48], [0.36, 1.0, 2.47], [0.45, 0.9, 2.45], [0.45, 0.64, 2.36]], 0.032, 36));
  K.add('trim', cylBetween(new THREE.Vector3(-0.45, 0.81, 2.435), new THREE.Vector3(0.45, 0.81, 2.435), 0.026));
  // Защита днища
  K.box('chrome', 0.9, 0.08, 0.3, 0, 0.4, 2.33);

  // --- Зад: бампер, фонари, задний борт, номер, фаркоп, выхлоп ---
  K.add('trim', xf(slab(2.0, 0.24, 0.22, 0.03), 0, 0.55, -2.3));
  for (const sx of [-1, 1]) {
    K.box('trim', 0.15, 0.36, 0.04, sx * 0.84, 0.9, -2.322);
    K.box('tail', 0.12, 0.3, 0.05, sx * 0.84, 0.92, -2.33);
    K.box('lens', 0.12, 0.045, 0.04, sx * 0.84, 0.745, -2.33);
    K.box('seam', 0.012, 0.44, 0.006, sx * 0.765, 0.91, -2.3145);
  }
  K.box('seam', 1.542, 0.012, 0.006, 0, 0.69, -2.3145);
  K.box('trim', 0.24, 0.05, 0.02, 0, 1.05, -2.318);
  // Третий стоп-сигнал над задним стеклом
  K.box('tail', 0.28, 0.03, 0.03, 0, 1.705, -0.625);
  K.box('plate', 0.5, 0.12, 0.02, 0, 0.62, -2.42);
  // Символы номера и код региона
  for (let i = 0; i < 6; i++) K.box('seam', 0.034, i === 0 || i > 3 ? 0.045 : 0.065, 0.004, 0.2 - i * 0.058, 0.615, -2.431);
  K.box('seam', 0.004, 0.1, 0.004, -0.15, 0.62, -2.431);
  for (let i = 0; i < 2; i++) K.box('seam', 0.022, 0.035, 0.004, -0.18 - i * 0.032, 0.635, -2.431);
  K.box('trim', 0.08, 0.08, 0.2, 0, 0.39, -2.4);
  K.box('seam', 0.05, 0.05, 0.004, 0, 0.39, -2.501);
  // Насадка выхлопа слева сзади в бампере — ровно там, где рождается пламя импульса (effects.js)
  K.add('chrome', xf(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 14), 0.55, 0.5, -2.43, Math.PI / 2));
  K.add('seam', xf(new THREE.CircleGeometry(0.038, 14), 0.55, 0.5, -2.4815, 0, Math.PI));

  bodyGeo = K.build();
  return bodyGeo;
}


// ---------- Дополнительные кузова ----------
// Профиль кузова (z, y) с арками под колёса, как у пикапа; w — ширина, b — фаска
function arcProfile(pts, archR = 0.53) {
  const sh = new THREE.Shape();
  sh.moveTo(...pts.rear[0]);
  for (let i = 1; i < pts.rear.length; i++) sh.lineTo(...pts.rear[i]);
  for (const p of pts.top) sh.lineTo(...p);
  if (pts.nose) sh.quadraticCurveTo(...pts.nose);
  for (const p of pts.front) sh.lineTo(...p);
  sh.lineTo(1.4 + archR, 0.44);
  sh.absarc(1.4, 0.44, archR, 0, Math.PI, false);
  sh.lineTo(-1.4 + archR, 0.44);
  sh.absarc(-1.4, 0.44, archR, 0, Math.PI, false);
  sh.lineTo(...pts.rear[0]);
  return sh;
}

function flares(K, x, r = 0.58, hgt = 0.44) {
  for (const sx of [-1, 1]) for (const az of [1.4, -1.4]) {
    K.add('trim', xf(new THREE.TorusGeometry(r, 0.05, 6, 18, Math.PI), sx * x, hgt, az, 0, Math.PI / 2));
  }
}

// Хэтчбек/купе: параметры определяют силуэт, оптику и обвес
function hatchBody(o) {
  const K = new Kit();
  const hw = o.width / 2;
  K.add('paint', extrudeSide(arcProfile({
    rear: [[-2.1, 0.46], [-2.14, 0.62], [-2.1, o.belt - 0.06]],
    top: [[-1.5, o.belt], [0.9, o.belt], [1.92, o.belt - 0.13]],
    nose: [2.16, o.belt - 0.19, 2.16, 0.62],
    front: [[2.14, 0.5], [1.94, 0.44]],
  }), o.width, 0.05));
  // Кабина
  const g = new THREE.Shape();
  g.moveTo(o.aZ1, o.belt); g.lineTo(o.aZ2, o.roofY); g.lineTo(o.cZ2, o.roofY); g.lineTo(o.cZ1, o.belt); g.lineTo(o.aZ1, o.belt);
  K.add('glass', extrudeSide(g, o.width - 0.2, 0.03));
  const rl = o.aZ2 - o.cZ2;
  K.box('paint', o.width - 0.16, 0.05, rl + 0.06, 0, o.roofY + 0.012, (o.aZ2 + o.cZ2) / 2);
  const aA = Math.atan2(o.aZ1 - o.aZ2, o.roofY - o.belt), aL = Math.hypot(o.aZ1 - o.aZ2, o.roofY - o.belt);
  const cA = Math.atan2(o.cZ2 - o.cZ1, o.roofY - o.belt), cL = Math.hypot(o.cZ2 - o.cZ1, o.roofY - o.belt);
  for (const sx of [-1, 1]) {
    K.box('paint', 0.06, aL, 0.09, sx * (hw - 0.1), (o.belt + o.roofY) / 2, (o.aZ1 + o.aZ2) / 2, -aA);
    K.box('paint', 0.06, cL, 0.11, sx * (hw - 0.1), (o.belt + o.roofY) / 2, (o.cZ1 + o.cZ2) / 2, cA);
    K.box('trim', 0.012, o.roofY - o.belt - 0.04, 0.07, sx * (hw - 0.07), (o.belt + o.roofY) / 2, (o.aZ2 + o.cZ2) / 2 + 0.1); // средняя стойка
    // двери и ручки, зеркала
    for (const z of [0.62, -0.1, o.doors4 ? -0.78 : -0.7]) K.box('seam', 0.006, o.belt - 0.5, 0.012, sx * (hw + 0.002), 0.75, z);
    for (const z of [0.25, -0.35]) K.box('trim', 0.022, 0.035, 0.12, sx * (hw + 0.006), o.belt - 0.12, z);
    K.box('paint', 0.18, 0.11, 0.08, sx * (hw + 0.1), o.belt + 0.12, o.aZ1 - 0.2);
    K.box('trim', 0.12, 0.03, 0.04, sx * (hw + 0.02), o.belt + 0.08, o.aZ1 - 0.18);
    // боковые пороги — контрастный низ («панда»)
    if (o.panda) K.box('trim', 0.025, 0.2, 2.9, sx * (hw + 0.006), 0.58, 0);
    else K.box('trim', 0.035, 0.07, 2.6, sx * (hw + 0.012), 0.5, 0);
    K.box('amber', 0.01, 0.04, 0.09, sx * (hw + 0.004), 0.78, 2.0);
    K.box('red', 0.01, 0.04, 0.09, sx * (hw + 0.004), 0.82, -2.0);
  }
  flares(K, hw + 0.04);
  for (const az of [1.4, -1.4]) K.add('liner', xf(flip(new THREE.CylinderGeometry(0.495, 0.495, o.width + 0.06, 12, 1, true, Math.PI, Math.PI)), 0, 0.44, az, 0, 0, -Math.PI / 2));
  // Капот: вставки, воздухозаборник
  K.add('paint', xf(slab(o.width - 0.4, 0.04, 1.25, 0.015), 0, o.belt + 0.005, 1.35, 0.06));
  if (o.scoop) {
    K.box('seam', 0.55, 0.05, 0.4, 0, o.belt + 0.07, 1.25);
    K.box('trim', 0.6, 0.04, 0.08, 0, o.belt + 0.1, 1.05);
  } else for (const sx of [-1, 1]) K.box('seam', 0.3, 0.012, 0.22, sx * 0.3, o.belt + 0.03, 1.4, 0.06);
  // Перед
  K.add('trim', xf(slab(o.width + 0.02, 0.22, 0.2, 0.03), 0, 0.55, 2.1));
  K.box('seam', 0.7, 0.13, 0.04, 0, 0.58, 2.2);
  K.add('chrome', xf(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 10), 0, 0.5, 2.215, Math.PI / 2));
  if (o.popup) {
    for (const sx of [-1, 1]) {
      K.box('trim', 0.4, 0.13, 0.06, sx * 0.55, o.belt - 0.08, 2.0);
      K.box('head', 0.32, 0.09, 0.03, sx * 0.55, o.belt - 0.08, 2.03);
    }
    K.box('trim', 1.1, 0.08, 0.04, 0, o.belt - 0.14, 2.12);
  } else {
    for (const sx of [-1, 1]) {
      K.box('trim', 0.4, 0.14, 0.06, sx * 0.62, o.belt - 0.1, 2.0);
      K.box('head', 0.34, 0.1, 0.02, sx * 0.62, o.belt - 0.1, 2.035);
      K.add('trim', xf(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 14), sx * 0.34, 0.6, 2.2, Math.PI / 2));
      K.add('head', xf(new THREE.CylinderGeometry(0.058, 0.058, 0.02, 14), sx * 0.34, 0.6, 2.21, Math.PI / 2));
    }
    if (o.pods) for (let i = 0; i < 4; i++) {
      K.add('trim', xf(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 14), -0.45 + i * 0.3, o.belt - 0.28, 2.2, Math.PI / 2));
      K.add('head', xf(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 14), -0.45 + i * 0.3, o.belt - 0.28, 2.24, Math.PI / 2));
    }
  }
  // Зад
  K.add('trim', xf(slab(o.width + 0.02, 0.2, 0.2, 0.03), 0, 0.55, -2.1));
  K.box('tail', o.width - 0.3, 0.14, 0.03, 0, o.belt - 0.14, -2.15);
  K.box('seam', o.width - 0.3, 0.012, 0.01, 0, o.belt - 0.14, -2.162);
  K.box('plate', 0.5, 0.11, 0.02, 0, 0.62, -2.2);
  for (let i = 0; i < 6; i++) K.box('seam', 0.034, 0.055, 0.004, 0.2 - i * 0.08, 0.615, -2.212);
  K.add('chrome', xf(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 14), 0.5, 0.45, -2.2, Math.PI / 2));
  // Спойлер
  if (o.wing === 'duck') K.add('paint', xf(slab(o.width - 0.2, 0.05, 0.3, 0.015), 0, o.belt + 0.05, -2.0, -0.12));
  if (o.wing === 'big') {
    for (const sx of [-1, 1]) {
      K.box('trim', 0.05, 0.5, 0.06, sx * 0.62, o.belt + 0.25, -1.95);
      K.box('paint', 0.03, 0.3, 0.5, sx * 0.92, o.belt + 0.5, -2.0);
    }
    K.add('trim', xf(slab(1.84, 0.045, 0.5, 0.015), 0, o.belt + 0.5, -2.0, -0.08));
  }
  // Крыша: воздухозаборник, полосы
  if (o.roofScoop) { K.box('seam', 0.3, 0.05, 0.3, 0, o.roofY + 0.07, 0.05); K.box('trim', 0.32, 0.03, 0.06, 0, o.roofY + 0.095, 0.2); }
  if (o.stripes) {
    K.box('trim', 0.34, 0.006, 1.2, 0, o.belt + 0.06, 1.4, 0.06);
    K.box('trim', 0.34, 0.006, 1.2, 0, o.roofY + 0.04, -0.03);
    K.box('trim', 0.34, 0.006, 0.6, 0, o.belt + 0.02, -1.7);
  }
  K.box('tail', 0.26, 0.025, 0.025, 0, o.roofY - 0.1, o.cZ2 - 0.2); // третий стоп
  return K.build();
}

function sportsBody() {
  const K = new Kit();
  K.add('paint', extrudeSide(arcProfile({
    rear: [[-2.18, 0.42], [-2.22, 0.7], [-2.12, 0.98]],
    top: [[-1.4, 1.03], [-0.2, 1.05], [1.1, 0.86]],
    nose: [2.22, 0.66, 2.26, 0.5],
    front: [[2.14, 0.4], [1.94, 0.4]],
  }, 0.5), 1.96, 0.06));
  const g = new THREE.Shape();
  g.moveTo(0.95, 0.93); g.lineTo(0.4, 1.3); g.lineTo(-0.1, 1.34); g.lineTo(-0.95, 1.12); g.lineTo(-1.35, 1.03); g.lineTo(0.95, 0.93);
  K.add('glass', extrudeSide(g, 1.5, 0.03));
  K.box('paint', 1.46, 0.045, 0.52, 0, 1.352, 0.15);
  for (const sx of [-1, 1]) {
    K.box('paint', 0.07, 0.62, 0.09, sx * 0.76, 1.12, 0.68, -0.8);
    K.box('seam', 0.01, 0.1, 0.6, sx * 0.985, 0.72, -0.7);           // боковые воздухозаборники
    K.box('seam', 0.01, 0.1, 0.12, sx * 0.985, 0.72, 0.55);
    K.box('trim', 0.02, 0.05, 2.7, sx * 0.99, 0.46, 0);
    K.box('paint', 0.16, 0.1, 0.08, sx * 1.04, 1.05, 0.95);
    K.box('amber', 0.01, 0.04, 0.09, sx * 0.99, 0.7, 2.0);
    // фары-«щели»
    K.box('trim', 0.5, 0.07, 0.07, sx * 0.62, 0.72, 2.12, 0.05, sx * 0.15);
    K.box('head', 0.42, 0.04, 0.03, sx * 0.62, 0.72, 2.16, 0.05, sx * 0.15);
    // антикрыло: стойки и пластины
    K.box('trim', 0.05, 0.42, 0.07, sx * 0.55, 1.2, -1.95);
    K.box('paint', 0.03, 0.26, 0.55, sx * 0.93, 1.48, -2.0);
    // выхлопы
    K.add('chrome', xf(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 14), sx * 0.3, 0.55, -2.24, Math.PI / 2));
    K.add('chrome', xf(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 14), sx * 0.52, 0.55, -2.24, Math.PI / 2));
  }
  flares(K, 1.0, 0.55, 0.42);
  for (const az of [1.4, -1.4]) K.add('liner', xf(flip(new THREE.CylinderGeometry(0.485, 0.485, 2.0, 12, 1, true, Math.PI, Math.PI)), 0, 0.44, az, 0, 0, -Math.PI / 2));
  K.add('trim', xf(slab(2.0, 0.05, 0.5, 0.02), 0, 0.4, 2.2));        // сплиттер
  K.add('trim', xf(slab(2.0, 0.07, 0.6, 0.02), 0, 0.42, -2.1));      // диффузор
  K.box('seam', 0.9, 0.1, 0.04, 0, 0.6, 2.24);                       // воздухозаборник
  K.box('seam', 0.34, 0.012, 0.5, 0, 0.88, 1.55, 0.18);              // вентиляция капота
  K.box('seam', 0.5, 0.012, 0.3, 0, 0.99, -1.5);
  K.box('tail', 1.66, 0.07, 0.03, 0, 0.9, -2.24);
  K.add('trim', xf(slab(1.9, 0.045, 0.55, 0.015), 0, 1.5, -2.0, -0.07)); // крыло
  K.box('plate', 0.5, 0.1, 0.02, 0, 0.7, -2.26);
  return K.build();
}

function buggyBody() {
  const K = new Kit();
  // Рама-«сковорода», носовая и моторная части
  K.add('paint', xf(slab(1.3, 0.1, 3.5, 0.03), 0, 0.5, 0));
  K.add('paint', xf(slab(1.16, 0.3, 1.1, 0.06), 0, 0.72, 1.55, 0.18));
  K.add('paint', xf(slab(1.1, 0.26, 1.2, 0.05), 0, 0.92, -1.55, -0.1));
  K.box('seam', 0.5, 0.05, 0.3, 0, 1.06, -1.4);                      // радиатор/жалюзи
  for (let i = 0; i < 4; i++) K.box('trim', 0.46, 0.012, 0.03, 0, 1.075, -1.5 + i * 0.1);
  K.add('chrome', xf(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 12), -0.35, 0.78, -2.15, Math.PI / 2));
  K.add('chrome', xf(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 12), 0.35, 0.78, -2.15, Math.PI / 2));
  // Сиденья
  for (const sx of [-0.3, 0.3]) {
    K.add('liner', xf(slab(0.5, 0.12, 0.5, 0.04), sx, 0.7, 0.05));
    K.add('liner', xf(slab(0.5, 0.62, 0.12, 0.04), sx, 1.0, -0.22, -0.15));
    K.box('trim', 0.14, 0.2, 0.06, sx, 1.4, -0.28);
  }
  K.box('trim', 0.3, 0.3, 0.05, 0, 1.0, 0.7, -0.5);                  // приборная панель
  K.add('trim', xf(new THREE.TorusGeometry(0.15, 0.02, 6, 16), 0, 1.15, 0.58, -0.6));
  // Каркас безопасности
  const tubeR = 0.035;
  const T = (pts) => K.add('trim', tube(pts, tubeR, pts.length * 6));
  for (const sx of [-1, 1]) {
    T([[sx * 0.6, 0.55, 0.85], [sx * 0.6, 1.1, 0.75], [sx * 0.55, 1.62, 0.2]]);               // передняя стойка
    T([[sx * 0.6, 0.55, -0.55], [sx * 0.6, 1.2, -0.52], [sx * 0.5, 1.64, -0.3]]);             // задняя стойка
    T([[sx * 0.55, 1.62, 0.2], [sx * 0.52, 1.66, -0.05], [sx * 0.5, 1.64, -0.3]]);            // верхняя продольная
    T([[sx * 0.6, 0.95, 0.75], [sx * 0.62, 0.95, 0.1], [sx * 0.6, 0.95, -0.53]]);             // боковая защита
    T([[sx * 0.5, 1.64, -0.3], [sx * 0.45, 1.3, -1.0], [sx * 0.45, 0.95, -1.5]]);             // подкос к мотору
    K.add('trim', cylBetween(new THREE.Vector3(sx * 0.6, 0.55, 0.85), new THREE.Vector3(sx * 0.45, 0.7, 1.7), tubeR));
    K.box('head', 0.22, 0.14, 0.04, sx * 0.4, 0.88, 2.12);            // фары в носу
    K.box('trim', 0.28, 0.2, 0.05, sx * 0.4, 0.88, 2.095);
    K.box('red', 0.01, 0.04, 0.09, sx * 0.66, 0.7, 2.0);
    K.box('tail', 0.2, 0.1, 0.04, sx * 0.42, 0.95, -2.18);            // задние фонари
    K.box('paint', 0.34, 0.05, 0.9, sx * 0.97, 0.88, 1.4, 0, 0, sx * 0.08);   // передние крылья
    K.box('paint', 0.34, 0.05, 0.9, sx * 0.97, 0.9, -1.4, 0, 0, sx * 0.08);
    K.box('trim', 0.04, 0.12, 0.9, sx * 1.12, 0.84, 1.4);
    K.box('trim', 0.04, 0.12, 0.9, sx * 1.12, 0.86, -1.4);
  }
  T([[-0.55, 1.62, 0.2], [0, 1.68, 0.2], [0.55, 1.62, 0.2]]);          // верхняя поперечная спереди
  T([[-0.5, 1.64, -0.3], [0, 1.68, -0.3], [0.5, 1.64, -0.3]]);
  T([[-0.6, 1.1, 0.75], [0, 1.15, 0.78], [0.6, 1.1, 0.75]]);
  // Светодиодная балка на каркасе
  K.box('trim', 1.0, 0.09, 0.09, 0, 1.72, 0.2);
  for (let i = 0; i < 5; i++) K.box('head', 0.15, 0.06, 0.012, -0.4 + i * 0.2, 1.72, 0.25);
  // Бамперы-трубы и защита
  K.add('chrome', tube([[-0.55, 0.7, 2.0], [-0.5, 0.65, 2.25], [0.5, 0.65, 2.25], [0.55, 0.7, 2.0]], 0.03, 20));
  K.add('chrome', tube([[-0.5, 0.75, -2.05], [-0.4, 0.62, -2.3], [0.4, 0.62, -2.3], [0.5, 0.75, -2.05]], 0.03, 20));
  K.box('plate', 0.4, 0.1, 0.02, 0, 0.64, -2.2);
  // Запаска на корме
  K.add('palRaw', xf(wheelGeometry(0.3, 0.2, 1).clone(), 0, 1.05, -2.0, Math.PI / 2, 0, 0));
  return K.build();
}

function monsterExtras() {
  const K = new Kit();
  K.add('liner', xf(slab(1.5, 0.36, 3.0, 0.05), 0, 0.5, 0));
  for (const sx of [-1, 1]) for (const az of [1.4, -1.4]) {
    K.add('chrome', cylBetween(new THREE.Vector3(sx * 0.35, 0.72, az), new THREE.Vector3(sx * 0.9, 0.5, az), 0.04));
    K.add('red', xf(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8), sx * 0.7, 0.62, az));
  }
  return K.build().pal;
}

const bodyCache = {};
const BODIES = {
  pickup: { geo: () => bodyGeometry(), wheelX: 0.9 },
  monster: { geo: () => bodyGeometry(), lift: 0.38, wheelR: 0.64, wheelW: 0.46, wheelX: 1.0, extra: monsterExtras },
  coupe: {
    geo: () => hatchBody({ width: 1.74, belt: 0.98, roofY: 1.45, aZ1: 1.0, aZ2: 0.48, cZ2: -0.52, cZ1: -1.5, popup: true, wing: 'duck', panda: true }),
    wheelX: 0.86,
  },
  rally: {
    geo: () => hatchBody({ width: 1.84, belt: 1.04, roofY: 1.6, aZ1: 1.05, aZ2: 0.5, cZ2: -1.0, cZ1: -1.55, doors4: true, wing: 'big', scoop: true, roofScoop: true, stripes: true, pods: true }),
    wheelX: 0.9,
  },
  sports: { geo: sportsBody, wheelX: 0.92 },
  buggy: { geo: buggyBody, wheelX: 0.98, wheelW: 0.4 },
};
function bodyFor(kind) {
  const d = BODIES[kind] || BODIES.pickup;
  if (!d.cache) d.cache = d.geo();
  if (d.extra && !d.extraGeo) d.extraGeo = d.extra();
  return d;
}

export function buildCarModel(color = 0xf4f4f2, kind = 'pickup') {
  const M = sharedMats();
  const def = bodyFor(kind);
  const G = def.cache;
  const wr = def.wheelR || 0.42, ww = def.wheelW || 0.33, wx = def.wheelX || 0.9;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const inner = new THREE.Group();
  inner.position.y = def.lift || 0;
  body.add(inner);

  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness: 0.35, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06,
  });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dc, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a0a, emissiveIntensity: 0.6 });

  const paintMesh = new THREE.Mesh(G.paint, paint);
  paintMesh.receiveShadow = true;
  inner.add(paintMesh);
  if (G.glass) inner.add(new THREE.Mesh(G.glass, M.glass));
  if (G.pal) inner.add(new THREE.Mesh(G.pal, M.pal));
  if (G.head) inner.add(new THREE.Mesh(G.head, headMat));
  if (G.tail) inner.add(new THREE.Mesh(G.tail, tailMat));
  if (def.extraGeo) inner.add(new THREE.Mesh(def.extraGeo, M.pal));

  // Колёса
  const wheelPos = [
    [wx, 1.4], [-wx, 1.4], // передние (лево, право)
    [wx, -1.4], [-wx, -1.4],
  ];
  const wheels = wheelPos.map(([x, z], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, wr, z);
    const spin = buildWheel(wr, ww, Math.sign(x));
    pivot.add(spin);
    root.add(pivot);
    return { pivot, spin, x, z, front: i < 2 };
  });

  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { root, body, wheels, tailMat, headMat, paint, wheelR: wr, kind };
}
