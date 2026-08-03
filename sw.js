/* 오프라인 캐시용 서비스워커 */
const CACHE = 'noise-meter-v9';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/dsp.js',
  './js/audio.js',
  './js/app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 날씨 API 등 외부요청은 항상 네트워크
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
