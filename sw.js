/* Offline copy of the till page.
   Without this, reloading the till with no internet shows the browser's
   "no connection" page, even though the products and the unsent-sales queue
   are kept on the device. The page is fetched from the network first, so a
   new version shows up straight away; the saved copy is only used when the
   network fails or takes too long. /api/* calls are never cached. */
const CACHE = 'till-v1';
const PAGE = '/';
const WAIT_MS = 4000;     // weak wifi: give up on the network after this and use the saved copy

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add(PAGE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;   // only the page itself
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(fromNetwork(req).catch(() =>
    caches.match(PAGE).then(r => r || Response.error())));
});

function fromNetwork(req) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), WAIT_MS);
    fetch(req).then(res => {
      clearTimeout(t);
      if (!res.ok) { resolve(res); return; }
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(PAGE, copy));
      resolve(res);
    }, err => { clearTimeout(t); reject(err); });
  });
}
