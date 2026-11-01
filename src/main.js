// Точка входа: сборка мира, игровой цикл, освещение, время суток, события.
import * as THREE from 'three';
import { QUALITY, QUALITY_NAME, PRESETS, AUTO_RES, save, load, IS_MOBILE, WIND } from './config.js';
import { setupApp, enterFullscreen } from './app.js';
import { Simplex2, clamp } from './noise.js';
import { Track } from './track.js';
import { Terrain } from './terrain.js';
import { TireTracks } from './tiretracks.js';
import { createSky } from './sky.js';
import { World } from './world.js';
import { Car, STYLES } from './car.js';
import { Bot } from './ai.js';
import { Particles } from './particles.js';
import { Effects } from './effects.js';
import { CameraRig } from './cameraRig.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Post } from './post.js';
import { HUD, fmtTime } from './hud.js';
import { Race, DriftScore } from './race.js';
import { Net, cleanName } from './net.js';
import { CARS, MAPS, Wallet, owned, buy, selectedMap, selectedCar } from './garage.js';

const PALETTES = {
  day: {
    sunDir: new THREE.Vector3(0.5, 0.62, 0.42).normalize(),
    sun: new THREE.Color(0xffeccc), sunI: 3.4,
    hemiSky: new THREE.Color(0xa9c4e2), hemiGround: new THREE.Color(0xc98e55), hemiI: 0.72,
    fog: new THREE.Color(0xe2bf8f), zenith: new THREE.Color(0x4a82c4), horizon: new THREE.Color(0xeacfa6),
    ground: new THREE.Color(0xd2a473), exposure: 0.92,
  },
  sunset: {
    sunDir: new THREE.Vector3(-0.82, 0.2, 0.36).normalize(),
    sun: new THREE.Color(0xffa25a), sunI: 2.8,
    hemiSky: new THREE.Color(0x8f9cc8), hemiGround: new THREE.Color(0xb7774a), hemiI: 0.85,
    fog: new THREE.Color(0xe0a679), zenith: new THREE.Color(0x2f4f8c), horizon: new THREE.Color(0xf5ab6a),
    ground: new THREE.Color(0xc98d62), exposure: 1.05,
  },
  night: {
    sunDir: new THREE.Vector3(0.35, 0.58, -0.45).normalize(), // луна
    sun: new THREE.Color(0x9fb6ee), sunI: 1.1,
    hemiSky: new THREE.Color(0x4a6094), hemiGround: new THREE.Color(0x3c3640), hemiI: 0.75,
    fog: new THREE.Color(0x1c2740), zenith: new THREE.Color(0x03071a), horizon: new THREE.Color(0x22304e),
    ground: new THREE.Color(0x2c2a30), exposure: 1.35, night: 1,
  },
};
// Оттенок выбранной карты: песок и небо
const MAP = selectedMap();
if (MAP.k) {
  const tint = new THREE.Color(MAP.tint);
  for (const [name, p] of Object.entries(PALETTES)) {
    const k = MAP.k * (p.night ? 0.4 : 1);
    for (const key of ['fog', 'horizon', 'ground']) p[key].lerp(tint, k);
  }
}
const TIME_ORDER = ['day', 'sunset', 'night'];
const TIME_NAMES = { day: 'День', sunset: 'Закат', night: 'Ночь' };

const loadingEl = document.getElementById('loading');
const playBtn = document.getElementById('play');
if (IS_MOBILE) document.body.classList.add('touch');
setupApp();

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function boot() {
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  let pixelRatio = Math.min(devicePixelRatio, QUALITY.maxPixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 3500);

  loadingEl.textContent = 'Насыпаем барханы…';
  await nextFrame();
  const noise = new Simplex2(MAP.seed);
  const track = new Track(noise);
  const terrain = new Terrain(noise, track);

  loadingEl.textContent = 'Рисуем песок и небо…';
  await nextFrame();
  const tireTracks = new TireTracks(renderer);
  tireTracks.prepaint(track, noise);
  scene.add(terrain.buildMesh(tireTracks));

  let pal = PALETTES.day;
  const sunDir = pal.sunDir.clone();
  const skyPal = { zenith: pal.zenith.clone(), horizon: pal.horizon.clone(), ground: pal.ground.clone(), sun: pal.sun.clone() };
  const sky = createSky(sunDir, skyPal);
  scene.add(sky);
  scene.fog = new THREE.Fog(pal.fog.clone(), 140, 1000);
  scene.background = pal.fog.clone();

  const hemi = new THREE.HemisphereLight(pal.hemiSky.clone(), pal.hemiGround.clone(), pal.hemiI);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(pal.sun.clone(), pal.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(QUALITY.shadowMap, QUALITY.shadowMap);
  const sc = sun.shadow.camera;
  sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 1; sc.far = 500;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  // Карта окружения для отражений (металл, лак, стекло)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), sky.material);
  envScene.add(envSky);
  const groundDisk = new THREE.Mesh(new THREE.CircleGeometry(39, 24), new THREE.MeshBasicMaterial({ color: pal.ground }));
  groundDisk.rotation.x = -Math.PI / 2;
  groundDisk.position.y = -2;
  envScene.add(groundDisk);
  const rebuildEnv = () => {
    if (scene.environment) scene.environment.dispose();
    scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 100).texture;
  };
  rebuildEnv();

  loadingEl.textContent = 'Расставляем ветряки и трейлеры…';
  await nextFrame();
  const world = new World(scene, terrain, track, noise);

  const car = new Car(terrain, 0xf2f2ee);
  scene.add(car.mesh);
  car.reset(0, -12, Math.PI);
  let styleName = STYLES[load('dd_style', 'arcade')] ? load('dd_style', 'arcade') : 'arcade';
  car.tune = STYLES[styleName];
  // Цвет кузова (сохраняется)
  const PAINTS = [0xf2f2ee, 0x1b1d21, 0xc8312a, 0xe8a628, 0x2f6fd1, 0x3f7a4a, 0xd96f2d, 0x8a8f96];
  let paintHex = Number(load('dd_paint', '')) || PAINTS[0];
  if (!PAINTS.includes(paintHex)) paintHex = PAINTS[0];
  car.model.paint.color.setHex(paintHex);
  let carDef = selectedCar();
  car.setSpec(carDef);

  const botDefs = [
    { color: 0x1f5fbf, hud: '#3b8cff', skill: 0.97 },
    { color: 0xd23a2a, hud: '#ff5a45', skill: 1.0 },
    { color: 0x2a2a2e, hud: '#bbbbbb', skill: 0.94 },
  ];
  const bots = botDefs.map((d, i) => {
    const b = new Bot(track, terrain, d.color, d.skill, Math.floor((i / botDefs.length) * track.count));
    b.hudColor = d.hud;
    scene.add(b.mesh);
    return b;
  });

  const particles = new Particles(QUALITY.particles, terrain);
  scene.add(particles.mesh);
  const effects = new Effects(particles, tireTracks, terrain);
  const race = new Race(scene, track, terrain);
  const drift = new DriftScore();
  const rig = new CameraRig(camera, terrain);
  rig.snap(car);
  const input = new Input();
  input.bindTouch(document.getElementById('touch'));
  const audio = new Audio();
  const post = new Post(renderer, scene, camera);
  post.setSize(innerWidth, innerHeight, pixelRatio);
  const hud = new HUD(track, [...terrain.sites, ...world.landmarks]);

  // Мультиплеер: все игроки на сайте — в одной пустыне (комната ?room=имя — своя карта для друзей)
  let playerName = cleanName(load('dd_name', ''));
  if (!playerName) { playerName = 'Гонщик-' + Math.floor(1000 + Math.random() * 9000); save('dd_name', playerName); }
  const room = MAP.id + '-' + (new URLSearchParams(location.search).get('room') || 'main');
  const net = new Net(scene, terrain, effects, { room, name: playerName, paint: paintHex });
  const netPill = document.getElementById('netPill');
  const netStatus = document.getElementById('netStatus');
  const showNet = () => {
    const on = net.enabled, ok = net.connected;
    const txt = !on ? 'ОФЛАЙН' : ok ? `ОНЛАЙН · ${net.count + 1}` : 'ПОДКЛЮЧЕНИЕ…';
    if (netPill.textContent !== txt) netPill.textContent = txt;
    netPill.classList.toggle('ok', on && ok);
    const st = !on ? 'Выключено — играешь один' : ok ? `Подключено · игроков в пустыне: ${net.count + 1}` : 'Подключаемся к серверу…';
    if (netStatus.textContent !== st) netStatus.textContent = st;
  };
  net.onStatus = showNet;
  const onlineChk = document.getElementById('online');
  onlineChk.checked = load('dd_online', '1') === '1';
  net.setEnabled(onlineChk.checked);
  onlineChk.addEventListener('change', () => { save('dd_online', onlineChk.checked ? '1' : '0'); net.setEnabled(onlineChk.checked); });
  const nameInp = document.getElementById('playerName');
  nameInp.value = playerName;
  nameInp.addEventListener('change', () => {
    const n = cleanName(nameInp.value);
    if (!n) { nameInp.value = playerName; return; }
    playerName = net.name = nameInp.value = n;
    save('dd_name', n);
    document.getElementById('whoName').textContent = n;
    document.getElementById('avatar').textContent = n[0].toUpperCase();
  });
  nameInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInp.blur(); });
  showNet();

  // Фары (включаются ночью)
  const headlights = [];
  for (const sx of [-0.7, 0.7]) {
    const l = new THREE.SpotLight(0xfff1d6, 150, 120, 0.55, 0.6, 1.25);
    l.position.set(sx, 0.9, 2.3);
    l.target.position.set(sx * 3, -2.2, 30);
    car.mesh.add(l, l.target);
    // фары всегда в сцене (днём яркость 0): включение ночью не пересобирает шейдеры — без фриза
    l.intensity = 0;
    headlights.push(l);
  }

  // Применение палитры времени суток
  let palName = 'day';
  const applyPalette = (p) => {
    sunDir.copy(p.sunDir);
    skyPal.zenith.copy(p.zenith); skyPal.horizon.copy(p.horizon); skyPal.ground.copy(p.ground); skyPal.sun.copy(p.sun);
    sun.color.copy(p.sun); sun.intensity = p.sunI;
    hemi.color.copy(p.hemiSky); hemi.groundColor.copy(p.hemiGround); hemi.intensity = p.hemiI;
    scene.fog.color.copy(p.fog);
    scene.background.copy(p.fog);
    groundDisk.material.color.copy(p.ground);
    renderer.toneMappingExposure = p.exposure;
    terrain.uniforms.uSunDir.value.copy(p.sunDir);
    particles.uniforms.uSunDir.value.copy(p.sunDir);
    particles.uniforms.uSunColor.value.copy(p.sun).multiplyScalar(p.sunI / 3.4);
    particles.uniforms.uAmbient.value.copy(p.hemiSky).lerp(p.hemiGround, 0.5).multiplyScalar(0.62 * p.hemiI);
    particles.uniforms.uFogColor.value.copy(p.fog);
    const night = p.night || 0;
    sky.userData.uniforms.uNight.value = night;
    for (const h of headlights) h.intensity = night ? 150 : 0;
    car.model.headMat.emissiveIntensity = night ? 7 : 2.2;
    for (const b of bots) b.model.headMat.emissiveIntensity = night ? 7 : 2.2;
    net.setNight(!!night);
    rebuildEnv();
  };
  applyPalette(pal);

  // Окно/ресайз
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.setSize(innerWidth, innerHeight, pixelRatio);
  };
  addEventListener('resize', onResize);

  // Обзор мышью
  let dragging = false, lastX = 0;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { dragging = true; lastX = e.clientX; } });
  addEventListener('pointerup', () => { dragging = false; });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    rig.orbit = clamp(rig.orbit - (e.clientX - lastX) * 0.006, -Math.PI, Math.PI);
    lastX = e.clientX;
  });

  // Прогресс игрока по трассе (для позиции в гонке)
  const prog = { idx: 0, laps: 0, reset: true };

  // Кнопки HUD
  const startRace = () => {
    if (race.active) { race.stop(bots); hud.toast('Свободная езда'); return; }
    race.start(car, bots);
    prog.reset = true;
    rig.snap(car);
    drift.reset();
    hud.toast('Гонка: 12 чекпоинтов, круги без конца', 'cyan');
  };
  const resetCar = () => {
    const h = car.heading;
    car.reset(car.pos.x, car.pos.z, h);
    drift.reset();
  };
  const toggleTime = () => {
    palName = TIME_ORDER[(TIME_ORDER.indexOf(palName) + 1) % TIME_ORDER.length];
    pal = PALETTES[palName];
    applyPalette(pal);
    hud.toast(TIME_NAMES[palName]);
  };
  const toggleSound = () => {
    audio.setEnabled(!audio.enabled);
    hud.toast(audio.enabled ? 'Звук включён' : 'Звук выключен');
  };
  const styleBtn = document.getElementById('btnStyle');
  const showStyle = () => {
    styleBtn.textContent = 'СТИЛЬ: ' + STYLES[styleName].label;
    document.getElementById('styleArcade').classList.toggle('on', styleName === 'arcade');
    document.getElementById('styleDrift').classList.toggle('on', styleName === 'drift');
  };
  showStyle();
  const toggleStyle = () => {
    styleName = styleName === 'arcade' ? 'drift' : 'arcade';
    car.tune = STYLES[styleName];
    save('dd_style', styleName);
    showStyle();
    hud.toast(styleName === 'drift' ? 'ДРИФТ: задний привод, корма скользит — держи угол газом и рулём' : 'АРКАДА: устойчивое управление', 'cyan');
  };
  const nextCam = () => { rig.next(); hud.toast('Камера: ' + rig.modeName); };
  const bindBtn = (id, fn) => document.getElementById(id).addEventListener('click', (e) => { fn(); e.currentTarget.blur(); });
  bindBtn('btnRace', startRace);
  bindBtn('btnStyle', toggleStyle);
  bindBtn('btnCam', nextCam);
  bindBtn('btnTime', toggleTime);
  bindBtn('btnSound', toggleSound);
  bindBtn('btnReset', resetCar);

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => {
    rebuildEnv();
    tireTracks.clear();
    tireTracks.prepaint(track, noise);
  });

  // Меню
  loadingEl.classList.add('hidden');
  playBtn.classList.remove('hidden');
  document.getElementById('menu').classList.add('ready');
  let running = false;
  let started = false;
  let openTab = 'garage';
  let revertPreview = () => {};
  const menuEl = document.getElementById('menu');
  const start = () => {
    revertPreview();
    rig.snap(car);
    menuEl.classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    audio.init();
    if (IS_MOBILE) enterFullscreen();
    running = true;
    if (!started) hud.bigText('ПОЕХАЛИ!', 1000);
    started = true;
    clock.getDelta();
    input.pressed.clear();
  };
  const openMenu = () => {
    running = false;
    playBtn.textContent = 'ПРОДОЛЖИТЬ';
    renderLobby();
    document.getElementById('hud').classList.add('hidden');
    menuEl.classList.remove('hidden');
    try { audio.ctx?.suspend(); } catch (e) { /* нет звука */ }
  };
  // Свернули приложение — пауза и тишина
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    if (running) openMenu();
    else try { audio.ctx?.suspend(); } catch (e) { /* нет звука */ }
  });
  playBtn.addEventListener('click', start);
  addEventListener('keydown', (e) => {
    if (!running && (e.code === 'Enter' || (e.code === 'Space' && started === false))) start();
    else if (running && (e.code === 'Escape' || e.code === 'KeyP')) openMenu();
    else if (!running && started && e.code === 'Escape') start();
  });
  bindBtn('btnMenu', openMenu);

  // Настройки графики: смена пресета требует перезапуска (пересоздаются рельеф и текстуры)
  const qWrap = document.getElementById('quality');
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'qbtn' + (key === QUALITY_NAME ? ' on' : '');
    b.textContent = p.label;
    b.addEventListener('click', () => {
      if (key === QUALITY_NAME) return;
      save('dd_quality', key);
      location.reload();
    });
    qWrap.appendChild(b);
  }
  const colorsEl = document.getElementById('colors');
  for (const hex of PAINTS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (hex === paintHex ? ' on' : '');
    b.style.background = '#' + hex.toString(16).padStart(6, '0');
    b.addEventListener('click', () => {
      revertPreview();
      paintHex = hex;
      net.paint = hex;
      car.model.paint.color.setHex(hex);
      save('dd_paint', String(hex));
      colorsEl.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
    });
    colorsEl.appendChild(b);
  }
  // Лобби: листание машин, вкладки, покупки за очки дрифта
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString('ru-RU');
  let pIdx = Math.max(0, CARS.findIndex((c) => c.id === carDef.id));
  const STATS = [['МОЩНОСТЬ', 'power'], ['РАЗГОН', 'force'], ['СЦЕПЛЕНИЕ', 'grip'], ['ИМПУЛЬС', 'boost'], ['ВЕС', 'mass']];
  const range = {};
  for (const [, k] of STATS) { const v = CARS.map((c) => c[k]); range[k] = [Math.min(...v), Math.max(...v)]; }
  $('whoName').textContent = playerName;
  $('avatar').textContent = playerName[0].toUpperCase();
  const selectCar = (c) => {
    carDef = c; save('dd_car', c.id);
    paintHex = c.paint; save('dd_paint', String(c.paint)); net.paint = c.paint;
    colorsEl.querySelectorAll('.swatch').forEach((x) => x.classList.remove('on'));
    hud.toast(c.name, 'cyan');
  };
  const showPreview = () => {
    const c = CARS[pIdx];
    car.setSpec(c);
    car.model.paint.color.setHex(c.id === carDef.id ? paintHex : c.paint);
  };
  revertPreview = () => {
    pIdx = Math.max(0, CARS.findIndex((c) => c.id === carDef.id));
    car.setSpec(carDef);
    car.model.paint.color.setHex(paintHex);
  };
  const renderMaps = () => {
    const list = $('mapList');
    list.textContent = '';
    for (const m of MAPS) {
      const has = owned.maps.has(m.id), sel = m.id === MAP.id;
      const row = document.createElement('div');
      row.className = 'item' + (sel ? ' sel' : '');
      const info = document.createElement('div');
      info.innerHTML = '<b></b><small></small>';
      info.firstChild.textContent = m.name; info.lastChild.textContent = m.desc;
      const btn = document.createElement('button');
      btn.className = 'ibtn';
      if (sel) { btn.textContent = 'ВЫБРАНО'; btn.disabled = true; }
      else if (has) btn.textContent = 'ВЫБРАТЬ';
      else { btn.textContent = '🪙 ' + fmt(m.price); btn.classList.toggle('poor', Wallet.balance < m.price); }
      btn.addEventListener('click', () => {
        if (!has && !buy('maps', m)) { hud.toast(`Не хватает ${fmt(m.price - Wallet.balance)} очков — дрифтуй!`, 'bad'); return; }
        save('dd_map', m.id);
        location.reload();
      });
      row.append(info, btn);
      list.appendChild(row);
    }
  };
  const renderCar = () => {
    const c = CARS[pIdx], has = owned.cars.has(c.id), sel = c.id === carDef.id;
    $('carBrand').textContent = `ГАРАЖ · ${pIdx + 1}/${CARS.length}`;
    $('carName').textContent = c.name;
    $('carDesc').textContent = c.desc;
    const bars = $('statBars');
    bars.textContent = '';
    for (const [label, k] of STATS) {
      const [lo, hi] = range[k];
      const v = 0.2 + 0.8 * (c[k] - lo) / (hi - lo || 1);
      const r = document.createElement('div');
      r.className = 'stat';
      r.innerHTML = '<span></span><i></i>';
      r.firstChild.textContent = label;
      r.lastChild.style.setProperty('--v', (v * 100).toFixed(0) + '%');
      bars.appendChild(r);
    }
    const b = $('carAct');
    b.className = 'act';
    b.disabled = sel;
    if (sel) b.textContent = 'ВЫБРАНО';
    else if (has) { b.textContent = 'ВЫБРАТЬ'; b.classList.add('pick'); }
    else { b.textContent = '🪙 КУПИТЬ · ' + fmt(c.price); b.classList.add(Wallet.balance >= c.price ? 'buy' : 'poor'); }
  };
  const renderLobby = () => {
    $('wallet').textContent = fmt(Wallet.balance);
    renderCar();
    if (openTab === 'maps') renderMaps();
  };
  $('carAct').addEventListener('click', () => {
    const c = CARS[pIdx];
    if (!owned.cars.has(c.id) && !buy('cars', c)) { hud.toast(`Не хватает ${fmt(c.price - Wallet.balance)} очков — дрифтуй!`, 'bad'); return; }
    selectCar(c);
    showPreview();
    renderLobby();
  });
  const stepCar = (d) => { pIdx = (pIdx + d + CARS.length) % CARS.length; showPreview(); renderLobby(); };
  $('prevCar').addEventListener('click', () => stepCar(-1));
  $('nextCar').addEventListener('click', () => stepCar(1));
  addEventListener('keydown', (e) => {
    if (running || menuEl.classList.contains('hidden') || e.target.tagName === 'INPUT') return;
    if (e.code === 'ArrowLeft') stepCar(-1); else if (e.code === 'ArrowRight') stepCar(1);
  });
  const sheet = $('sheet');
  const setTab = (t) => {
    if (t === openTab && t !== 'garage') t = 'garage';
    openTab = t;
    sheet.classList.toggle('hidden', t === 'garage');
    sheet.dataset.open = t;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    renderLobby();
  };
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('styleArcade').addEventListener('click', () => { if (styleName !== 'arcade') toggleStyle(); });
  $('styleDrift').addEventListener('click', () => { if (styleName !== 'drift') toggleStyle(); });
  showStyle();
  renderLobby();

  const autoRes = document.getElementById('autoRes');
  autoRes.checked = AUTO_RES;
  let autoResOn = AUTO_RES;
  autoRes.addEventListener('change', () => {
    autoResOn = autoRes.checked;
    save('dd_autores', autoResOn ? '1' : '0');
    if (!autoResOn) { pixelRatio = Math.min(devicePixelRatio, QUALITY.maxPixelRatio); renderer.setPixelRatio(pixelRatio); onResize(); }
  });

  // Позиция в гонке: считаем пересечения линии старта
  const playerProgress = () => {
    if (prog.reset) { prog.idx = track.nearest(car.pos.x, car.pos.z).index; prog.laps = 0; prog.reset = false; }
    const n = track.nearest(car.pos.x, car.pos.z, prog.idx, 30).index;
    if (prog.idx > track.count * 0.8 && n < track.count * 0.2) prog.laps++;
    else if (prog.idx < track.count * 0.2 && n > track.count * 0.8) prog.laps--;
    prog.idx = n;
    return prog.laps * track.count + n;
  };

  // Дрифт-зона
  const zone = { def: terrain.bowl, inside: false, score: 0, best: Number(load('dd_zone_best', 0)) || 0 };
  const zonePill = document.getElementById('zonePill');
  const zoneScoreEl = document.getElementById('zoneScore');
  const zoneBestEl = document.getElementById('zoneBest');

  // Игровой цикл
  const clock = new THREE.Clock();
  const STEP = 1 / 120;
  let acc = 0;
  let fpsT = 0, fpsN = 0;
  const _up = new THREE.Vector3(0, 1, 0), _lr = new THREE.Vector3(), _lu = new THREE.Vector3(), _lt = new THREE.Vector3();
  const windVel = { x: WIND.x * WIND.strength, z: WIND.z * WIND.strength };
  const zeroInput = { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false, jump: false };
  let lastCount = -1;
  let jumpLatch = false;
  let netT = 0, trackFrame = 0, lobbyA = 0.6;
  const esc = (t) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const frame = () => {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 1 / 20);

    // Пауза (меню): мир стоит, только рисуем кадр под меню
    if (!running) {
      input.update(dt);
      if (input.pressed.has('Start')) start();
      input.pressed.clear();
      // подвеска и колёса по рельефу — иначе машина в лобби «проваливается» в песок
      car._computeWheels();
      car.updateVisual();
      car.mesh.position.y += 0.07 * car.spec.scale; // протектор шин чуть ниже расчётного радиуса — приподнимаем, чтобы не тонул
      lobbyA += dt * 0.32;
      const sc = car.spec.scale, dd = 10.8 * sc, cp = car.pos;
      camera.position.set(cp.x + Math.sin(lobbyA) * dd, cp.y + 2.6 * sc, cp.z + Math.cos(lobbyA) * dd);
      camera.lookAt(cp.x, cp.y + 0.8, cp.z);
      if (camera.fov !== 38) { camera.fov = 38; camera.updateProjectionMatrix(); }
      net.update(dt, car, camera.position, true);
      sky.position.copy(camera.position);
      post.render(dt, 0, 0);
      return;
    }
    if (input.consume('Start')) openMenu();

    // горячие клавиши
    if (input.consume('KeyC')) nextCam();
    if (input.consume('KeyV')) toggleStyle();
    if (input.consume('KeyT')) startRace();
    if (input.consume('KeyN')) toggleTime();
    if (input.consume('KeyM')) toggleSound();
    if (input.consume('KeyR')) resetCar();

    let inp = input.update(dt);
    if (race.active && race.countdown > 0) inp = zeroInput;
    if (inp === zeroInput) jumpLatch = false;
    else if (inp.jump) jumpLatch = true;

    // Физика с фиксированным шагом (нажатие прыжка держим до ближайшего шага)
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 8) {
      inp.jump = jumpLatch;
      jumpLatch = false;
      car.step(STEP, inp);
      world.collideCar(car);
      acc -= STEP;
      steps++;
    }
    net.collide(car);
    car.updateVisual();
    for (const b of bots) b.update(dt, car);

    // События машины
    for (const ev of car.events) {
      if (ev.type === 'land') {
        rig.addShake(Math.min(0.9, ev.strength * 0.05));
        audio.impact(ev.strength, 'land');
        effects.burst(car.pos.x, car.pos.y, car.pos.z, Math.min(40, 8 + ev.strength * 2), 3 + ev.strength * 0.3);
        if (ev.spin > 300) {
          const turns = Math.round(ev.spin / 180) * 180;
          drift.bonus(`ВРАЩЕНИЕ ${turns}°`, Math.round(turns * 2));
          hud.bigText(`${turns}°`, 900);
        }
        if (ev.air > 0.7) {
          const pts = Math.round(ev.air * 450);
          drift.bonus('ПОЛЁТ', pts);
          car.boost = Math.min(1, car.boost + 0.15);
        }
      } else if (ev.type === 'hit') {
        rig.addShake(Math.min(1, ev.strength * 0.06));
        audio.impact(ev.strength, 'hit');
        effects.burst(ev.x, car.pos.y, ev.z, 10, 3, [0.7, 0.5, 0.32], 8, [0.35, 0.28, 0.2]);
        if (ev.strength > 5) drift.fail();
      } else if (ev.type === 'jump') {
        audio.blip(320, 0.15, 0.08);
        effects.burst(car.pos.x, car.pos.y, car.pos.z, 12, 3);
      }
    }
    car.events.length = 0;
    for (const ev of world.events) {
      if (ev.type === 'smash') {
        audio.impact(ev.strength * 0.5, ev.obj === 'barrel' ? 'hit' : 'wood');
        const chip = ev.obj === 'barrel' ? [0.5, 0.15, 0.1] : ev.obj === 'tires' ? [0.05, 0.05, 0.05] : [0.35, 0.24, 0.14];
        effects.burst(ev.x, ev.y - 0.4, ev.z, 6, 2.5, [0.74, 0.52, 0.32], 10, chip);
        rig.addShake(0.12);
        if (ev.obj !== 'tumbleweed') drift.bonus('РАЗНОС', 25);
      }
    }
    world.events.length = 0;

    world.update(dt, car.pos);

    // Дрифт-зона в чаше: очки ×2, рекорд заезда по зоне
    if (zone.def) {
      const dz = Math.hypot(car.pos.x - zone.def.x, car.pos.z - zone.def.z);
      const inside = zone.inside ? dz < zone.def.r * 1.3 : dz < zone.def.r * 1.12;
      if (inside !== zone.inside) {
        zone.inside = inside;
        zonePill.classList.toggle('hidden', !inside);
        if (inside) { drift.bank(); drift.zoneMult = 2; zone.score = 0; hud.toast('ДРИФТ-ЗОНА: очки ×2', 'cyan'); }
        else {
          // незавершённый занос засчитывается в зону при выезде
          if (drift.current > 50) zone.score += Math.round(drift.current * drift.mult * 2);
          drift.bank();
          drift.zoneMult = 1;
          if (zone.score > 0) {
            const rec = zone.score > zone.best;
            if (rec) { zone.best = zone.score; save('dd_zone_best', String(zone.best)); }
            hud.toast(`Заезд по зоне: ${zone.score.toLocaleString('ru-RU')}${rec ? ' — РЕКОРД!' : ''}`, 'good');
            if (rec) hud.bigText('РЕКОРД ЗОНЫ!', 1200);
          }
        }
      }
      if (inside) {
        const live = zone.score + Math.round(drift.current * drift.mult * 2);
        const ls = live.toLocaleString('ru-RU'), bs = zone.best.toLocaleString('ru-RU');
        if (zoneScoreEl.textContent !== ls) zoneScoreEl.textContent = ls;
        if (zoneBestEl.textContent !== bs) zoneBestEl.textContent = bs;
      }
    }

    // Дрифт и гонка
    drift.update(dt, car);
    if (drift.active) car.boost = Math.min(1, car.boost + dt * 0.05 * drift.mult);
    for (const ev of drift.events) {
      if (ev.type === 'bank') {
        hud.toast(`+${ev.pts.toLocaleString('ru-RU')} ДРИФТ <small>x${ev.mult}${ev.zone > 1 ? ' · зона ×' + ev.zone : ''}</small>`, 'good');
        if (zone.inside && ev.zone > 1) zone.score += ev.pts;
      }
      else if (ev.type === 'fail') hud.toast(`ДРИФТ СОРВАН −${ev.pts.toLocaleString('ru-RU')}`, 'bad');
      else if (ev.type === 'bonus') hud.toast(`${ev.label} +${ev.pts}`, 'cyan');
    }
    drift.events.length = 0;

    if (race.active && race.countdown > 0) {
      const c = Math.ceil(race.countdown);
      if (c !== lastCount && c <= 3) { lastCount = c; hud.bigText(String(c), 800); audio.blip(520, 0.15); }
    }
    const rev = race.update(dt, car);
    if (race.active && race.countdown <= 0 && lastCount > 0) { lastCount = 0; hud.bigText('СТАРТ!', 900); audio.blip(1040, 0.3); }
    if (rev?.type === 'cp') { audio.blip(1180, 0.1); hud.toast('ЧЕКПОИНТ ' + fmtTime(race.time), 'cyan'); }
    if (rev?.type === 'lap') {
      audio.blip(880, 0.4);
      hud.bigText(rev.best ? 'РЕКОРД!' : 'КРУГ!', 1200);
      hud.toast(`Круг ${fmtTime(rev.time)}${rev.best ? ' — лучший!' : ''}`, 'good');
    }
    if (!race.active) lastCount = -1;
    let position = 1;
    if (race.active) {
      const pp = playerProgress();
      for (const b of bots) if (b.progress() > pp) position++;
    } else playerProgress();

    // Эффекты
    effects.car(car, dt);
    bots.forEach((b, i) => effects.bot(b, dt, i));
    effects.ambient(car.pos, dt);
    net.update(dt, car, camera.position);
    for (const ev of net.events) {
      if (ev.type === 'join') hud.toast(`${esc(ev.name)} в пустыне`, 'cyan');
      else hud.toast(`${esc(ev.name)} уехал`);
    }
    if (net.events.length) showNet();
    net.events.length = 0;
    netT += dt;
    if (netT > 1) { netT = 0; showNet(); }
    particles.uniforms.uTime.value += dt;
    particles.update(dt, windVel);
    if (!IS_MOBILE || (++trackFrame % 3) === 0) tireTracks.update();
    terrain.uniforms.uTime.value += dt;
    sky.userData.uniforms.uTime.value += dt;

    // Камера, солнце следует за машиной (снап к текселю — без мерцания теней)
    rig.update(car, dt);
    if (!dragging) rig.orbit *= Math.exp(-2.5 * dt);
    window.__cine?.(dt, car, camera); // хук для съёмки роликов
    sky.position.copy(camera.position);
    const texel = (sc.right - sc.left) / QUALITY.shadowMap;
    _lr.crossVectors(_up, sunDir).normalize();
    _lu.crossVectors(sunDir, _lr);
    const la = Math.round(car.pos.dot(_lr) / texel) * texel, lb = Math.round(car.pos.dot(_lu) / texel) * texel;
    _lt.copy(_lr).multiplyScalar(la).addScaledVector(_lu, lb).addScaledVector(sunDir, car.pos.dot(sunDir));
    sun.target.position.copy(_lt);
    sun.position.copy(_lt).addScaledVector(sunDir, 250);

    audio.update(car, dt);
    hud.update(dt, car, drift, race, bots, rig, camera, { gear: audio.gear, position, remotes: net.remotes });

    post.render(dt, clamp(car.speed / 50, 0, 1), car.boosting ? 1 : 0);

    // Динамическое разрешение: держим ~60 FPS
    fpsT += dt; fpsN++;
    if (fpsT > 2 && !autoResOn) { fpsT = 0; fpsN = 0; }
    if (fpsT > 2) {
      const fps = fpsN / fpsT;
      let pr = pixelRatio;
      if (fps < 48) pr = Math.max(0.6, pixelRatio - 0.15);
      else if (fps > 58 && pixelRatio < Math.min(devicePixelRatio, QUALITY.maxPixelRatio)) pr = Math.min(Math.min(devicePixelRatio, QUALITY.maxPixelRatio), pixelRatio + 0.1);
      if (Math.abs(pr - pixelRatio) > 0.01) {
        pixelRatio = pr;
        renderer.setPixelRatio(pr);
        onResize();
      }
      fpsT = 0; fpsN = 0;
    }
  };
  frame();

  // для отладки из консоли
  window.__game = { effects, particles, net, car, world, terrain, race, drift, bots, rig, renderer, scene, camera, start, startRace, toggleTime, input };
}

boot().catch((e) => {
  console.error(e);
  loadingEl.textContent = 'Ошибка запуска: ' + e.message;
});
