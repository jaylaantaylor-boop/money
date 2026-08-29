const CACHE_PREFIX = 'money-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const SHELL = ['./', './index.html', './app.js', './engine.js', './store.js', './manifest.json',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  // Promise.all, not allSettled: a half-cached shell activates believing it is ready, and
  // then an offline load serves index.html's HTML where a JS module was requested, which
  // fails to parse and stops the app booting. Better to fail the install and retry later.
  e.waitUntil(caches.open(CACHE_NAME)
    .then(c => c.addAll(SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // let fonts go to the network
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);       // never bare caches.match()
        const hit = await cache.match(e.request);
        if (hit) return hit;
        // Only a navigation may fall back to the shell. Serving index.html for a missed
        // image or module hands back HTML where binary or JS was expected, which fails
        // more confusingly than a plain miss.
        if (e.request.mode === 'navigate') return cache.match('./index.html');
        return Response.error();
      })
  );
});
