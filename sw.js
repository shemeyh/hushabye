// Offline support: everything the app needs is cached on first visit, so it
// keeps working in airplane mode. Bump VERSION when files change.
const VERSION = 'hushabye-v1';
const CORE = [
  './', 'index.html', 'phone-test.html', 'manifest.webmanifest',
  'css/app.css',
  'js/app.js', 'js/state-machine.js', 'js/sound-engine.js', 'js/womb-filter.js',
  'js/detector.js', 'js/heuristic.js', 'js/dsp.js', 'js/store.js',
  'js/worklets/capture-processor.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/mediapipe/audio_bundle.mjs',
  'vendor/mediapipe/wasm/audio_wasm_internal.js',
  'vendor/mediapipe/wasm/audio_wasm_internal.wasm',
  'models/yamnet.tflite',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from the cache at once, and refresh the cached copy in the background.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
