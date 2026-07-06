const CACHE_NAME = 'verticore-v1';
const ASSETS = ['./index.html', './app.js', './manifest.json', './icon-96.png', './icon-192.png', './icon-512.png', './'];
// App shell files that change often — always try the network first so updates
// show up immediately; only fall back to cache when genuinely offline.
const NETWORK_FIRST = ['index.html', 'app.js', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isAppShell = NETWORK_FIRST.some(f => e.request.url.indexOf(f) > -1) || e.request.mode === 'navigate';

  if (isAppShell) {
    // Network-first: always get the latest version when online.
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Static assets (icons etc.) — cache-first is fine, they rarely change.
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return resp;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
