/* 서비스워커 — 네트워크 우선(항상 최신) + 오프라인 캐시 폴백 + 설치 가능(PWA) */
const CACHE = 'noise-meter-v10';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/dsp.js',
  './js/audio.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 외부 요청(날씨 API 등)은 서비스워커가 관여하지 않음
  if (url.origin !== location.origin) return;
  // 네트워크 우선: 온라인이면 항상 최신, 실패(오프라인)면 캐시
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
