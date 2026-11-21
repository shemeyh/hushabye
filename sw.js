// Offline support: everything the app needs is cached on first visit, so it
// keeps working in airplane mode. Bump VERSION (and APP_VERSION in js/app.js)
// when files change.
const VERSION = 'hushabye-v6';
const CORE = [
  './', 'index.html', 'phone-test.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/state-machine.js', 'js/sound-engine.js', 'js/womb-filter.js', 'js/womb-sounds.js',
  'js/detector.js', 'js/heuristic.js', 'js/dsp.js', 'js/store.js',
  'js/worklets/capture-processor.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/mediapipe/audio_bundle.mjs',
  'vendor/mediapipe/wasm/audio_wasm_internal.js',
  'vendor/mediapipe/wasm/audio_wasm_internal.wasm',
  'models/yamnet.tflite',
];
const NETWORK_WAIT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(CORE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The big, never-changing files (model, WebAssembly) come straight from the
// cache. Everything else tries the network first, so a reload shows the
// latest version, and falls back to the cache when offline or slow.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const heavy = /\/(vendor|models)\//.test(url.pathname);
  event.respondWith(heavy ? cacheFirst(req) : networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (!cached) return fresh;
  const slow = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
  return Promise.race([fresh.catch(() => cached), slow]);
}
