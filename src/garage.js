// Гараж и карты: каталог, кошелёк (очки дрифта = монеты), покупки и выбор.
// Всё хранится в localStorage; оплату реальными деньгами подключим позже на сервере.
import { load, save } from './config.js';

// power/force — мощность и тяга, mass — масса, grip — сцепление, boost — запас импульса, scale — размер модели
export const CARS = [
  { id: 'jeep', kind: 'pickup', name: 'Пустынный джип', price: 0, desc: 'Сбалансированный пикап, как раньше',
    paint: 0xf2f2ee, power: 1, force: 1, mass: 1, grip: 1, boost: 1, scale: 1 },
  { id: 'buggy', kind: 'buggy', name: 'Багги', price: 1500, desc: 'Открытый каркас, лёгкий и юркий: быстро разгоняется, но слабее держит дорогу',
    paint: 0xe8a628, power: 1.12, force: 1.18, mass: 0.78, grip: 0.97, boost: 1.1, scale: 0.92 },
  { id: 'coupe', kind: 'coupe', name: 'Дрифт-купе', price: 3000, desc: 'Лёгкое заднеприводное купе в стиле 80-х: легко держит занос',
    paint: 0xf2f2ee, power: 1.15, force: 1.1, mass: 0.85, grip: 0.98, boost: 1.1, scale: 1 },
  { id: 'pickup', kind: 'monster', name: 'Монстр-пикап', price: 5000, desc: 'Поднятый пикап на огромных колёсах: тяжёлый и мощный',
    paint: 0x3f7a4a, power: 1.3, force: 1.12, mass: 1.25, grip: 1.04, boost: 0.9, scale: 1 },
  { id: 'rally', kind: 'rally', name: 'Ралли-хэтч', price: 7500, desc: 'Раллийный хэтчбек с антикрылом: мощный и цепкий, большой запас импульса',
    paint: 0x2f6fd1, power: 1.45, force: 1.35, mass: 1.0, grip: 1.1, boost: 1.4, scale: 1 },
  { id: 'phantom', kind: 'sports', name: 'Фантом', price: 15000, desc: 'Низкий спорткар: максимум мощности и скорости',
    paint: 0x1b1d21, power: 1.75, force: 1.5, mass: 0.95, grip: 1.12, boost: 1.6, scale: 1 },
];

// Биом карты определяет рельеф, растительность, скалы, озеро и погоду (см. terrain.js, world.js, worldExtras.js, weather.js)
// tint/k — оттенок неба и дымки
export const MAPS = [
  { id: 'dunes', name: 'Золотые дюны', price: 0, seed: 1337, desc: 'Классическая пустыня: барханы, кактусы, оазис',
    sand: [0xd9a064, 0xe9b679, 0xb7773f], tint: 0xd2a473, k: 0, biome: {} },
  { id: 'red', name: 'Красный каньон', price: 2500, seed: 4242, desc: 'Ступенчатые плато, десятки красных скал и мезы, сухие деревья',
    sand: [0xc0613e, 0xd57a52, 0x8e3b25], tint: 0xc4694a, k: 0.45,
    biome: { dune: 0.4, hills: 0.7, terrace: 7, rocks: 2.4, rockBig: 1.7, rockDark: 0x6b2f1e, rockLight: 0xc9704c,
      mesas: 16, mesaScale: 1.15, dust: [0.82, 0.45, 0.3], mesaCols: [0x7a3a26, 0xb8643f, 0x9a4d30], screeCol: 0xa8553a, cactus: 0.35, trees: 'dead', treeMul: 0.8, shrubs: 0.35, tumble: 10 } },
  { id: 'snow', name: 'Снежная пустошь', price: 5000, seed: 90210, desc: 'Заснеженные холмы, сосновый лес, ледяное озеро и снегопад',
    sand: [0xe6edf5, 0xffffff, 0xaebdd2], tint: 0xcdd9ea, k: 0.6, exposure: 0.82,
    biome: { dune: 0.5, hills: 1.1, rocks: 1.0, rockDark: 0x5f6b7a, rockLight: 0xf1f5fa, mesas: 6, mesaCols: [0x8fa3b8, 0xeaf1f8, 0xb5c6d8], screeCol: 0xdfe8f2,
      cactus: 0, trees: 'pine', treeMul: 8, dust: [0.92, 0.95, 1.0], shrubs: 0.5, shrubHSL: [0.38, 0.35, 0.22], tumble: 0, lake: 'ice', lakeName: 'ЛЕДЯНОЕ ОЗЕРО', weather: 'snow' } },
  { id: 'volcano', name: 'Вулканическая равнина', price: 9000, seed: 777, desc: 'Чёрный пепел, действующий вулкан, лавовое озеро и летящие искры',
    sand: [0x3d3532, 0x57493f, 0x1f1a19], tint: 0x6a3a2a, k: 0.5,
    biome: { dune: 0.75, hills: 1.2, rocks: 1.7, rockBig: 1.2, rockDark: 0x1e1a19, rockLight: 0x5e4a42, mesas: 5, mesaCols: [0x241f1d, 0x4a3a33, 0x2f2724], screeCol: 0x2c2523,
      cactus: 0, trees: 'dead', treeMul: 0.7, treeCol: 0x2a2220, shrubs: 0.0, tumble: 0, dust: [0.34, 0.3, 0.28], lake: 'lava', lakeName: 'ЛАВОВОЕ ОЗЕРО', volcano: true, weather: 'embers' } },
];

// карты, переименованные при обновлении: старые покупки переходят на новые
const MAP_ALIAS = { white: 'snow', night: 'volcano' };
const getList = (key) => { try { return JSON.parse(load(key, '[]')) || []; } catch (e) { return []; } };

export const Wallet = {
  get earned() { return Number(load('dd_total', 0)) || 0; },
  get spent() { return Number(load('dd_spent', 0)) || 0; },
  get balance() { return Math.max(0, this.earned - this.spent); },
  spend(n) {
    if (this.balance < n) return false;
    save('dd_spent', String(this.spent + n));
    return true;
  },
};

export const owned = { cars: new Set(['jeep', ...getList('dd_cars')]), maps: new Set(['dunes', ...getList('dd_maps').map((id) => MAP_ALIAS[id] || id)]) };

export function buy(kind, item) {
  const set = owned[kind];
  if (set.has(item.id)) return true;
  if (!Wallet.spend(item.price)) return false;
  set.add(item.id);
  save(kind === 'cars' ? 'dd_cars' : 'dd_maps', JSON.stringify([...set]));
  return true;
}

export function selectedMap() {
  let id = load('dd_map', 'dunes');
  id = MAP_ALIAS[id] || id;
  const m = MAPS.find((x) => x.id === id);
  return m && owned.maps.has(m.id) ? m : MAPS[0];
}
export function selectedCar() {
  const id = load('dd_car', 'jeep');
  const c = CARS.find((x) => x.id === id);
  return c && owned.cars.has(c.id) ? c : CARS[0];
}
