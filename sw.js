// オフライン対応: stale-while-revalidate
// キャッシュがあれば即座に返しつつ、裏でネットワークから最新版を取得してキャッシュを更新する。
const CACHE_NAME = 'upsize-v1';
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './resize-worker.js',
  './manifest.webmanifest',
  './icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 同一オリジンのみ対象

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    const revalidate = (async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        return cached; // オフライン等はキャッシュへフォールバック
      }
    })();
    if (cached) {
      event.waitUntil(revalidate); // 裏側の更新はレスポンスを待たせず継続させる
      return cached;
    }
    const res = await revalidate;
    return res || Response.error();
  })());
});
