// Service worker: игра целиком кэшируется и работает без интернета.
// При обновлении игры поменяйте VERSION, чтобы телефоны скачали новые файлы.
const VERSION = 'dd-v10';
const FILES = [
  './',
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./lib/three/LICENSE",
  "./lib/three/addons/postprocessing/EffectComposer.js",
  "./lib/three/addons/postprocessing/MaskPass.js",
  "./lib/three/addons/postprocessing/OutputPass.js",
  "./lib/three/addons/postprocessing/Pass.js",
  "./lib/three/addons/postprocessing/RenderPass.js",
  "./lib/three/addons/postprocessing/ShaderPass.js",
  "./lib/three/addons/postprocessing/UnrealBloomPass.js",
  "./lib/three/addons/shaders/CopyShader.js",
  "./lib/three/addons/shaders/LuminosityHighPassShader.js",
  "./lib/three/addons/shaders/OutputShader.js",
  "./lib/three/addons/utils/BufferGeometryUtils.js",
  "./lib/three/three.module.min.js",
  "./manifest.webmanifest",
  "./src/ai.js",
  "./src/app.js",
  "./src/audio.js",
  "./src/cameraRig.js",
  "./src/car.js",
  "./src/carModel.js",
  "./src/config.js",
  "./src/effects.js",
  "./src/hud.js",
  "./src/input.js",
  "./src/garage.js",
  "./src/main.js",
  "./src/net.js",
  "./src/noise.js",
  "./src/particles.js",
  "./src/post.js",
  "./src/race.js",
  "./src/shaders/sand.js",
  "./src/sky.js",
  "./src/terrain.js",
  "./src/textures.js",
  "./src/tiretracks.js",
  "./src/track.js",
  "./src/world.js",
  "./src/worldExtras.js",
  "./style.css",
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — не брать устаревшие копии из HTTP-кэша браузера
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сеть с таймаутом: свежая версия, если сеть быстрая; иначе через 3 с — из кэша (без долгого ожидания на слабом интернете)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    });
    if (!cached) return net.catch(() => caches.match('./index.html'));
    return Promise.race([net.catch(() => cached), new Promise((r) => setTimeout(() => r(cached), 3000))]);
  })());
});
