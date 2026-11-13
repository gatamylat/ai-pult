const cacheName = 'ai-pult-v02';
const files = ['./', './index.html', './style.css', './pult.js', './modules/core.js', './modules/library.js',
  './modules/sync.js', './manifest.webmanifest', './icon.svg', './touch.png'];
const urls = new Set(files.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key =>
    key.startsWith('ai-pult-') && key !== cacheName).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !urls.has(event.request.url)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) return response;
    return caches.match(event.request).then(cached => cached || response);
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});
