const CACHE_NAME = 'biz-english-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/style.css',
  './js/data.js',
  './js/data-extra.js',
  './js/app.js',
  './js/sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// 페이지/스크립트/스타일은 최신 내용을 우선 시도하고(네트워크 우선), 오프라인일 때만
// 캐시된 버전으로 대체합니다. 아이콘 등 잘 바뀌지 않는 자산은 캐시를 우선 사용합니다.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  const isAsset = url.pathname.includes('/icons/');
  if (isAsset) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(res => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match('./index.html')))
  );
});
