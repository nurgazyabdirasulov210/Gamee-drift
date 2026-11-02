// Дополнительные локации и объекты: дрифт-чаша, оазис с пальмами, брошенные машины, автобус,
// заброшенная заправка, радиовышка, столовые горы, кактусы, ящики, указатели.
import * as THREE from 'three';
import { selectedMap } from './garage.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildCarModel } from './carModel.js';
import { mulberry32, clamp } from './noise.js';
import { HALF } from './config.js';
import { corrugatedTexture, bannerTexture } from './textures.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function strip(g) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g.index ? g.toNonIndexed() : g;
}
const merge = (list) => mergeGeometries(list.map(strip), false);
function boxAt(w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx); g.rotateZ(rz); g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}
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

function signTexture(text, bg = '#d8b07a', fg = '#3a2412') {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 4; i++) { g.fillStyle = 'rgba(60,35,15,.25)'; g.fillRect(0, i * 32, 512, 2); }
  g.fillStyle = fg;
  g.font = 'bold 64px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BIO = selectedMap().biome || {};

export function buildExtras(w) {
  const T = w.terrain;
  const rnd = mulberry32(9090);
  w.landmarks = [];

  // Впадины занимают место заранее
  for (const st of T.sites) w.occupy(st.x, st.z, st.r * 1.3);

  // ---------- Дрифт-чаша ----------
  if (T.bowl) {
    const b = T.bowl;
    const R = b.r * 1.18;
    const segs = Math.floor((2 * Math.PI * R) / 3);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      if (Math.abs(Math.sin(a - 0.4)) < 0.12) continue; // два въезда
      w.addDynamic('fence', b.x + Math.cos(a) * R, b.z + Math.sin(a) * R, -a);
    }
    // покрышки на дне по кругу — для «восьмёрок»
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      w.addDynamic('tires', b.x + Math.cos(a) * 14, b.z + Math.sin(a) * 14, a);
    }
    w.addDynamic('tires', b.x, b.z, 0);
    // прожекторные мачты
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const x = b.x + Math.cos(a) * (R + 5), z = b.z + Math.sin(a) * (R + 5);
      w.place(makeLightMast(w), x, z, -a + Math.PI / 2);
      w.addCircle(x, z, 0.4, 14);
    }
    placeSign(w, b.x + Math.cos(0.4) * (R + 8), b.z + Math.sin(0.4) * (R + 8), -0.4 + Math.PI / 2, 'ДРИФТ-ЧАША');
  }

  // ---------- Оазис / ледяное озеро / лавовое озеро ----------
  if (T.oasis) {
    const o = T.oasis, lake = o.lake || 'oasis';
    const water = makeWater(w, o.r * 0.82, lake);
    water.position.set(o.x, o.water, o.z);
    w.scene.add(water);
    if (lake === 'oasis') {
      for (let i = 0; i < 11; i++) {
        const a = (i / 11) * Math.PI * 2 + rnd() * 0.4;
        const r = o.r * (0.85 + rnd() * 0.45);
        const x = o.x + Math.cos(a) * r, z = o.z + Math.sin(a) * r;
        const palm = makePalm(w, 5 + Math.floor(rnd() * 1000));
        const s = 0.8 + rnd() * 0.5;
        palm.scale.setScalar(s);
        w.place(palm, x, z, rnd() * 6.28, 0.1);
        w.addCircle(x, z, 0.4 * s, 9 * s);
      }
      // тростник у воды
      for (let i = 0; i < 40; i++) {
        const a = rnd() * 6.28, r = o.r * (0.7 + rnd() * 0.25);
        w.extraShrubs.push({ x: o.x + Math.cos(a) * r, z: o.z + Math.sin(a) * r, s: 0.9 + rnd() * 0.8, green: true });
      }
      w.place(makeTent(w), o.x + o.r * 1.5, o.z + 6, 1.2);
      w.addBox(o.x + o.r * 1.5, o.z + 6, 2.2, 2.2, 1.2, 2.6);
    }
    placeSign(w, o.x + o.r * 1.8, o.z - 10, 0.6, BIO.lakeName || 'ОАЗИС');
  }

  // ---------- Вулкан ----------
  if (BIO.volcano) {
    for (let t2 = 0; t2 < 400; t2++) {
      const a = rnd() * 6.28, r = 520 + rnd() * 120;
      const x = clamp(Math.cos(a) * r, -HALF + 200, HALF - 200), z = clamp(Math.sin(a) * r, -HALF + 200, HALF - 200);
      if (!w.isFree(x, z, 170, 20)) continue;
      const v = makeVolcano(w, 190, 190);
      w.place(v, x, z, rnd() * 6.28, 6);
      w.addCircle(x, z, 150, 400);
      w.landmarks.push({ type: 'mesa', x, z, r: 160 });
      w.occupy(x, z, 190);
      break;
    }
  }

  // ---------- Брошенные ржавые машины ----------
  const rusts = [0x7b4a2c, 0x5f4a3a, 0x8a5a36, 0x4e5a5c, 0x93714a];
  let n = 0, tries = 0;
  while (n < 12 && tries++ < 3000) {
    const x = (rnd() - 0.5) * 1440, z = (rnd() - 0.5) * 1440;
    if (!w.isFree(x, z, 4, 6)) continue;
    const car = buildCarModel(rusts[n % rusts.length]);
    car.paint.roughness = 0.85; car.paint.metalness = 0.3; car.paint.clearcoat = 0;
    car.tailMat.emissiveIntensity = 0; car.headMat.emissiveIntensity = 0;
    car.wheels.forEach((wh) => { if (rnd() < 0.5) wh.pivot.visible = false; else wh.pivot.position.y = 0.3; });
    const ry = rnd() * 6.28;
    w.place(car.root, x, z, ry, 0.25);
    car.root.rotation.z = (rnd() - 0.5) * 0.25;
    car.root.rotation.x = (rnd() - 0.5) * 0.15;
    bakeStatic(car.root, w.scene);
    w.addBox(x, z, 1.0, 2.3, ry, 1.8);
    w.landmarks.push({ type: 'wreck', x, z });
    w.occupy(x, z, 5);
    n++;
  }

  // ---------- Старый автобус ----------
  for (let k = 0, t2 = 0; k < 3 && t2 < 2000; t2++) {
    const x = (rnd() - 0.5) * 1300, z = (rnd() - 0.5) * 1300;
    if (!w.isFree(x, z, 8, 8)) continue;
    const ry = rnd() * 6.28;
    const bus = makeBus(w);
    w.place(bus, x, z, ry, 0.2);
    bus.rotation.z = (rnd() - 0.5) * 0.12;
    w.addBox(x, z, 1.3, 5.6, ry, 3.2);
    w.landmarks.push({ type: 'bus', x, z });
    w.occupy(x, z, 9);
    for (let i = 0; i < 3; i++) w.addDynamic('crate', x + (rnd() - 0.5) * 8, z + (rnd() - 0.5) * 8, rnd() * 6);
    k++;
  }

  // ---------- Заброшенная заправка ----------
  for (let t2 = 0; t2 < 2000; t2++) {
    const a = rnd() * 6.28, r = 200 + rnd() * 400;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!w.isFree(x, z, 22, 10)) continue;
    if (T.getNormal(x, z).y < 0.95) continue;
    const ry = rnd() * 6.28;
    w.place(makeGasStation(w), x, z, ry);
    w.landmarks.push({ type: 'gas', x, z });
    const c = Math.cos(ry), s = Math.sin(ry);
    const loc = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    for (const [px, pz] of [[-5, -4], [5, -4], [-5, 4], [5, 4]]) { const [qx, qz] = loc(px, pz); w.addCircle(qx, qz, 0.4, 5); }
    for (const px of [-2, 2]) { const [qx, qz] = loc(px, 0); w.addCircle(qx, qz, 0.6, 1.8); }
    const [bx, bz] = loc(0, -11); w.addBox(bx, bz, 4.2, 2.6, ry, 3.6);
    const [sx, sz] = loc(9, 6); w.addCircle(sx, sz, 0.4, 9);
    w.occupy(x, z, 20);
    for (let i = 0; i < 6; i++) { const [qx, qz] = loc(-8 + rnd() * 3, -8 + rnd() * 4); w.addDynamic('barrel', qx, qz, 0); }
    for (let i = 0; i < 4; i++) { const [qx, qz] = loc(6 + rnd() * 3, -9 + rnd() * 3); w.addDynamic('crate', qx, qz, rnd() * 6); }
    break;
  }

  // ---------- Радиовышки с мигающими огнями ----------
  for (let k = 0, t2 = 0; k < 2 && t2 < 2000; t2++) {
    const x = (rnd() - 0.5) * 1300, z = (rnd() - 0.5) * 1300;
    if (!w.isFree(x, z, 8, 10)) continue;
    w.place(makeRadioTower(w), x, z, rnd() * 6.28);
    w.addCircle(x, z, 2.2, 40);
    w.landmarks.push({ type: 'tower', x, z });
    w.occupy(x, z, 10);
    k++;
  }

  // ---------- Столовые горы по краям ----------
  for (let k = 0, t2 = 0; k < (BIO.mesas ?? 6) && t2 < 4000; t2++) {
    const a = rnd() * 6.28;
    const r = 470 + rnd() * 240;
    const x = clamp(Math.cos(a) * r, -HALF + 90, HALF - 90), z = clamp(Math.sin(a) * r, -HALF + 90, HALF - 90);
    const rad = (28 + rnd() * 30) * (BIO.mesaScale ?? 1);
    if (!w.isFree(x, z, rad, 15)) continue;
    const mesa = makeMesa(w, rad, (22 + rnd() * 30) * (BIO.mesaScale ?? 1), 50 + k * 7);
    w.place(mesa, x, z, rnd() * 6.28, 2);
    w.addCircle(x, z, rad * 0.95, 80);
    w.landmarks.push({ type: 'mesa', x, z, r: rad });
    w.occupy(x, z, rad + 8);
    k++;
  }

  // ---------- Кактусы ----------
  const cactusGeo = makeCactusGeo();
  const cMat = new THREE.MeshStandardMaterial({ color: 0x5f7a45, roughness: 0.85 });
  const list = [];
  for (let i = 0; i < 260 && list.length < Math.round(140 * (BIO.cactus ?? 1)); i++) {
    const x = (rnd() - 0.5) * 1480, z = (rnd() - 0.5) * 1480;
    if (!w.isFree(x, z, 1, 3)) continue;
    list.push({ x, z, s: 0.7 + rnd() * 0.7, r: rnd() * 6.28 });
  }
  w.addChunked(cactusGeo, cMat, list.map((c) => {
    _q.setFromAxisAngle(UP, c.r);
    _m.compose(_v.set(c.x, w.h(c.x, c.z) - 0.1, c.z), _q, _s.set(c.s, c.s, c.s));
    w.addCircle(c.x, c.z, 0.35 * c.s, 4 * c.s);
    return { m: _m.clone() };
  }));

  // ---------- Ящики в лагере и указатели ----------
  for (let i = 0; i < 8; i++) w.addDynamic('crate', -12 + (i % 4) * 1.15, -24 + Math.floor(i / 4) * 1.15, 0.1);
  placeSign(w, 0, 66, 0, 'ЛАГЕРЬ');
  placeSign(w, 0, -70, Math.PI, 'К ТРАССЕ');
}

// Неподвижный объект из многих мешей → по одному мешу на материал (меньше вызовов отрисовки)
function bakeStatic(root, scene) {
  root.updateMatrixWorld(true);
  const byMat = new Map();
  let ok = true;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (Array.isArray(o.material) || o.isInstancedMesh) { ok = false; return; }
    let vis = true;
    for (let p = o; p; p = p.parent) vis = vis && p.visible;
    if (!vis) return;
    const g = strip(o.geometry.clone()).applyMatrix4(o.matrixWorld);
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  if (!ok) return;
  root.removeFromParent();
  for (const [mat, list] of byMat) {
    const m = new THREE.Mesh(mergeGeometries(list, false), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  }
}

// ---------- Конструкторы ----------
function placeSign(w, x, z, ry, text) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(merge([boxAt(0.15, 2.6, 0.15, -1.3, 1.3, 0), boxAt(0.15, 2.6, 0.15, 1.3, 1.3, 0)]), w.mats.woodDark);
  g.add(post);
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 0.8, 0.08),
    [w.mats.woodDark, w.mats.woodDark, w.mats.woodDark, w.mats.woodDark,
      new THREE.MeshStandardMaterial({ map: signTexture(text), roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ map: signTexture(text), roughness: 0.9 })],
  );
  board.position.y = 2.2;
  board.rotation.z = 0.04;
  g.add(board);
  w.place(g, x, z, ry);
  w.addCircle(x, z, 0.5, 2.6);
}

function makeLightMast(w) {
  const g = new THREE.Group();
  const p = [cylBetween(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 12, 0), 0.18, 0.12, 8), boxAt(3, 0.15, 0.15, 0, 12, 0)];
  g.add(new THREE.Mesh(merge(p), w.mats.metal));
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1cc, emissiveIntensity: 1.5 });
  for (const x of [-1.1, 0, 1.1]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.35, 0.25), lampMat);
    l.position.set(x, 12.2, 0.2);
    l.rotation.x = 0.5;
    g.add(l);
  }
  return g;
}

function makeWater(w, r, kind = 'oasis') {
  const lava = kind === 'lava', ice = kind === 'ice';
  const mat = lava
    ? new THREE.MeshStandardMaterial({ color: 0x1a0905, emissive: 0xff4a0e, emissiveIntensity: 1.5, roughness: 0.55, metalness: 0 })
    : ice
      ? new THREE.MeshStandardMaterial({ color: 0xa9d9ea, roughness: 0.07, metalness: 0.1, transparent: true, opacity: 0.93 })
      : new THREE.MeshStandardMaterial({ color: 0x1f6670, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.88 });
  const u = { uTime: { value: 0 } };
  w.waters.push(u);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const wave = ice ? 0.0 : lava ? 0.03 : 0.06;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWP;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 p = vWP.xz;
        float t = uTime;
        vec2 gr = vec2(cos(p.x * 1.3 + t * 1.7) + cos(p.x * 0.7 - p.y * 0.9 + t * 1.1) * 0.6,
                       cos(p.y * 1.5 - t * 1.4) + cos(p.y * 0.8 + p.x * 0.6 + t * 0.9) * 0.6) * ${wave.toFixed(3)};
        normal = normalize((viewMatrix * vec4(normalize(vec3(-gr.x, 1.0, -gr.y)), 0.0)).xyz);`);
    if (lava) {
      // корка и раскалённые трещины: яркость течёт по поверхности
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec2 q = vWP.xz * 0.35;
        float n1 = sin(q.x * 1.7 + uTime * 0.35) * sin(q.y * 1.3 - uTime * 0.28) + sin((q.x + q.y) * 2.3 + uTime * 0.5) * 0.5;
        float crust = smoothstep(-0.2, 0.55, n1);
        totalEmissiveRadiance *= mix(1.7, 0.18, crust);`);
    }
  };
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), mat);
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  return m;
}

// Вулкан: вогнутый конус с рваными склонами, раскалённым кратером и потёками лавы
function makeVolcano(w, rad, height) {
  const n = w.noise;
  const prof = [];
  const N = 56;
  for (let i = 0; i <= N; i++) {
    const t = i / N * 0.93;
    prof.push(new THREE.Vector2(rad * Math.pow(1 - t / 0.93 * 0.86, 1.7) + rad * 0.02, t * height));
  }
  prof.push(new THREE.Vector2(rad * 0.15, height * 0.93), new THREE.Vector2(rad * 0.11, height * 0.88), new THREE.Vector2(0.01, height * 0.86));
  const geo = new THREE.LatheGeometry(prof, 120);
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3);
  const c = new THREE.Color(), dark = new THREE.Color(0x1d1817), ash = new THREE.Color(0x4a3d36), hot = new THREE.Color(0xff5a14);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const a = Math.atan2(_v.z, _v.x), yN = _v.y / height;
    const ca = Math.cos(a), sa = Math.sin(a);
    // низкочастотная рябь по окружности (без швов: шум зависит от cos/sin угла)
    const k = 1 + 0.14 * n.noise(ca * 2.2 + 3, sa * 2.2 + yN * 2) + 0.05 * n.noise(ca * 6, sa * 6 + yN * 7);
    pos.setXYZ(i, _v.x * k, _v.y, _v.z * k);
    const streak = Math.max(0, n.noise(ca * 4 + 11, sa * 4) - 0.05) * smoothex(0.3, 0.9, yN);
    c.copy(dark).lerp(ash, 0.35 + 0.3 * n.noise(ca * 5, sa * 5 + yN * 5)).lerp(hot, Math.min(1, streak * 2.6));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, emissive: 0xff3a08, emissiveIntensity: 0.0, side: THREE.DoubleSide }));
  m.castShadow = true;
  g.add(m);
  // светящаяся лава в кратере
  const lava = new THREE.Mesh(new THREE.CircleGeometry(rad * 0.11, 24),
    new THREE.MeshStandardMaterial({ color: 0x1a0905, emissive: 0xff5412, emissiveIntensity: 3.4 }));
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = height * 0.885;
  g.add(lava);
  return g;
}
function smoothex(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
const smoothstep01 = smoothex;

function makePalm(w, seed) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();
  const parts = [];
  const lean = new THREE.Vector3((rnd() - 0.5) * 0.5, 1, (rnd() - 0.5) * 0.5).normalize();
  let p = new THREE.Vector3();
  const H = 7 + rnd() * 3;
  const segs = 10;
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const dir = lean.clone().lerp(UP, 1 - t * 0.6).normalize();
    const n = p.clone().addScaledVector(dir, H / segs);
    n.x += lean.x * t * 0.4; n.z += lean.z * t * 0.4;
    parts.push(cylBetween(p, n, 0.24 - t * 0.08, 0.22 - t * 0.08, 7));
    // кольца коры
    const ring = new THREE.TorusGeometry(0.22 - t * 0.08, 0.035, 4, 10);
    ring.rotateX(Math.PI / 2);
    ring.translate(n.x, n.y, n.z);
    parts.push(ring);
    pts.push(n);
    p = n;
  }
  const trunk = new THREE.Mesh(merge(parts), w.mats.palmTrunk || (w.mats.palmTrunk = new THREE.MeshStandardMaterial({ color: 0x7b6045, roughness: 0.95 })));
  g.add(trunk);
  // листья: изогнутые полосы
  const leaves = [];
  const top = p;
  const N = 9;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rnd() * 0.3;
    const len = 3.6 + rnd() * 1.4;
    const geo = new THREE.PlaneGeometry(len, 0.9, 8, 2);
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k) + len / 2; // 0..len
      const y = pos.getY(k);
      const t = x / len;
      const width = Math.sin(Math.PI * Math.min(1, t * 1.2)) * (1 - t * 0.5);
      pos.setXYZ(k, x, -t * t * 2.2 + Math.abs(y) * 0.25, y * width);
    }
    geo.computeVertexNormals();
    geo.rotateY(a);
    geo.rotateZ(0);
    geo.translate(top.x, top.y, top.z);
    leaves.push(geo);
  }
  const leafMat = w.mats.palmLeaf || (w.mats.palmLeaf = new THREE.MeshStandardMaterial({ color: 0x4f7a32, roughness: 0.8, side: THREE.DoubleSide }));
  g.add(new THREE.Mesh(merge(leaves), leafMat));
  // кокосы
  const nuts = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.SphereGeometry(0.15, 6, 5);
    s.translate(top.x + Math.cos(i * 1.6) * 0.25, top.y - 0.25, top.z + Math.sin(i * 1.6) * 0.25);
    nuts.push(s);
  }
  g.add(new THREE.Mesh(merge(nuts), w.mats.palmTrunk));
  return g;
}

function makeTent(w) {
  const g = new THREE.Group();
  const cone = new THREE.ConeGeometry(2.6, 2.6, 6, 1, true);
  cone.translate(0, 1.3, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd9cdb4, roughness: 0.95, side: THREE.DoubleSide });
  g.add(new THREE.Mesh(cone, mat));
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.4, 0.3, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0xa8382a, roughness: 0.9, side: THREE.DoubleSide }));
  stripe.position.y = 0.6;
  g.add(stripe);
  return g;
}

function makeBus(w) {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ map: corrugatedTexture(41, [196, 150, 52], 1.0), roughness: 0.8, metalness: 0.3 });
  yellow.map.repeat.set(3, 1);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.6, 11), yellow);
  body.position.y = 1.85;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 11, 12, 1, false, -Math.PI / 2, Math.PI), yellow);
  roof.rotation.x = Math.PI / 2;
  roof.rotation.z = 0;
  roof.scale.set(1, 1, 0.25);
  roof.position.y = 3.15;
  g.add(roof);
  const d = [];
  for (const sx of [-1, 1]) d.push(boxAt(0.04, 0.8, 9.2, sx * 1.26, 2.45, -0.2));
  d.push(boxAt(2.2, 1.0, 0.04, 0, 2.4, 5.51));
  g.add(new THREE.Mesh(merge(d), w.mats.glass));
  const t = [];
  for (const sx of [-1, 1]) t.push(boxAt(0.04, 0.12, 10.8, sx * 1.27, 1.6, 0));
  t.push(boxAt(2.5, 0.35, 0.3, 0, 0.75, 5.55));
  t.push(boxAt(2.5, 0.35, 0.3, 0, 0.75, -5.55));
  for (const [x, z] of [[1.05, 3.6], [-1.05, 3.6], [1.05, -3.2], [-1.05, -3.2]]) {
    const wh = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 12);
    wh.rotateZ(Math.PI / 2);
    wh.translate(x, 0.42, z);
    t.push(wh);
  }
  g.add(new THREE.Mesh(merge(t), w.mats.dark));
  return g;
}

function makeGasStation(w) {
  const g = new THREE.Group();
  // навес
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0xe8e1d2, roughness: 0.7 });
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(13, 0.7, 11), canopyMat);
  canopy.position.y = 5.2;
  canopy.rotation.z = 0.04;
  g.add(canopy);
  const band = new THREE.Mesh(new THREE.BoxGeometry(13.1, 0.3, 11.1), w.mats.red);
  band.position.y = 4.95;
  band.rotation.z = 0.04;
  g.add(band);
  const pil = [];
  for (const [x, z] of [[-5, -4], [5, -4], [-5, 4], [5, 4]]) pil.push(boxAt(0.45, 5, 0.45, x, 2.5, z));
  g.add(new THREE.Mesh(merge(pil), canopyMat));
  // колонки
  const pumps = [];
  for (const x of [-2, 2]) {
    pumps.push(boxAt(1.2, 0.3, 2.2, x, 0.15, 0));
    pumps.push(boxAt(0.7, 1.7, 0.9, x, 1.15, 0));
  }
  g.add(new THREE.Mesh(merge(pumps), w.mats.red));
  const scr = [];
  for (const x of [-2, 2]) scr.push(boxAt(0.5, 0.35, 0.92, x, 1.6, 0));
  g.add(new THREE.Mesh(merge(scr), w.mats.dark));
  // здание
  const shop = new THREE.Mesh(new THREE.BoxGeometry(8.4, 3.4, 5.2), new THREE.MeshStandardMaterial({ map: corrugatedTexture(55, [190, 180, 160], 0.8), roughness: 0.8 }));
  shop.position.set(0, 1.7, -11);
  g.add(shop);
  const win = [boxAt(3.5, 1.4, 0.05, -1.5, 1.8, -8.37), boxAt(1.1, 2.2, 0.05, 2.6, 1.1, -8.37)];
  g.add(new THREE.Mesh(merge(win), w.mats.glass));
  // стела
  const pole = new THREE.Mesh(cylBetween(new THREE.Vector3(9, 0, 6), new THREE.Vector3(9, 8, 6), 0.18, 0.15, 8), w.mats.metal);
  g.add(pole);
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(4.6, 1.2, 0.2),
    [w.mats.dark, w.mats.dark, w.mats.dark, w.mats.dark,
      new THREE.MeshStandardMaterial({ map: bannerTexture('ТОПЛИВО'), roughness: 0.6, emissive: 0x220000 }),
      new THREE.MeshStandardMaterial({ map: bannerTexture('ТОПЛИВО'), roughness: 0.6, emissive: 0x220000 })],
  );
  board.position.set(9, 8.4, 6);
  board.rotation.z = -0.12;
  g.add(board);
  return g;
}

function makeRadioTower(w) {
  const g = new THREE.Group();
  const H = 40;
  const parts = [];
  const corners = [0, 1, 2].map((i) => (i / 3) * Math.PI * 2);
  const at = (a, y) => { const r = 1.8 - (y / H) * 1.3; return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r); };
  for (const a of corners) parts.push(cylBetween(at(a, 0), at(a, H), 0.08, 0.06, 5));
  for (let y = 0; y < H; y += 2.5) {
    for (let k = 0; k < 3; k++) {
      const a = corners[k], b = corners[(k + 1) % 3];
      parts.push(cylBetween(at(a, y), at(b, y + 2.5), 0.03, 0.03, 3));
      parts.push(cylBetween(at(a, y + 2.5), at(b, y + 2.5), 0.03, 0.03, 3));
    }
  }
  const stripes = new THREE.MeshStandardMaterial({ color: 0xd9d4cc, metalness: 0.5, roughness: 0.5 });
  g.add(new THREE.Mesh(merge(parts), stripes));
  // антенны
  const ant = [];
  for (let i = 0; i < 3; i++) ant.push(boxAt(0.5, 1.4, 0.15, Math.cos(i * 2.1) * 0.7, H - 6, Math.sin(i * 2.1) * 0.7, -i * 2.1));
  g.add(new THREE.Mesh(merge(ant), w.mats.white));
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 4 });
  const l = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), lightMat);
  l.position.y = H + 0.3;
  g.add(l);
  const l2 = l.clone();
  l2.position.y = H * 0.55;
  g.add(l2);
  w.blinkers.push(lightMat);
  return g;
}

function makeMesa(w, rad, height, seed) {
  const n = w.noise;
  const geo = new THREE.CylinderGeometry(rad * 0.82, rad, height, 48, 14, false);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const mc = BIO.mesaCols || [0x8a5a3a, 0xc98c5a, 0xa86a42];
  const dark = new THREE.Color(mc[0]), light = new THREE.Color(mc[1]), band = new THREE.Color(mc[2]);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const a = Math.atan2(_v.z, _v.x);
    const yN = (_v.y + height / 2) / height;
    const isTop = Math.abs(_v.y - height / 2) < 0.01 && Math.hypot(_v.x, _v.z) < rad * 0.83 - 0.5;
    if (!isTop) {
      const k = 1 + 0.12 * n.noise(Math.cos(a) * 3 + seed, yN * 4) + 0.06 * n.noise(Math.cos(a) * 9, Math.sin(a) * 9 + yN * 10)
        + 0.05 * Math.sin(yN * 30) * (yN > 0.15 ? 1 : 0);
      _v.x *= k; _v.z *= k;
    }
    pos.setXYZ(i, _v.x, _v.y + height / 2, _v.z);
    const strata = 0.5 + 0.5 * Math.sin(yN * 22 + n.noise(a * 2, seed) * 2);
    c.copy(dark).lerp(light, yN * 0.8).lerp(band, strata * 0.35);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, w.mats.rock);
  g.add(m);
  // осыпь у подножия
  const scree = new THREE.CylinderGeometry(rad * 1.05, rad * 1.35, height * 0.18, 48, 1, true);
  scree.translate(0, height * 0.09, 0);
  g.add(new THREE.Mesh(scree, new THREE.MeshStandardMaterial({ color: BIO.screeCol ?? 0xc08a58, roughness: 1 })));
  return g;
}

function makeCactusGeo() {
  const parts = [];
  parts.push(cylBetween(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, 3.6, 0), 0.32, 0.27, 10));
  const top = new THREE.SphereGeometry(0.27, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  top.translate(0, 3.6, 0);
  parts.push(top);
  for (const [dir, h, len] of [[1, 1.4, 1.3], [-1, 2.0, 1.0]]) {
    parts.push(cylBetween(new THREE.Vector3(0, h, 0), new THREE.Vector3(dir * 0.7, h + 0.15, 0), 0.18, 0.18, 8));
    parts.push(cylBetween(new THREE.Vector3(dir * 0.7, h, 0), new THREE.Vector3(dir * 0.72, h + len, 0), 0.19, 0.17, 8));
    const cap = new THREE.SphereGeometry(0.17, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.translate(dir * 0.72, h + len, 0);
    parts.push(cap);
  }
  return merge(parts);
}
