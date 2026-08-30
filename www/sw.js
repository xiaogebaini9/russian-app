// Service Worker for offline caching
const CACHE = 'russian-app-v35';
const URLS = ['index.html', 'style.css', 'manifest.json', 'privacy.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
  );
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Network-first for HTML (always get latest), cache-first for everything else
  if (e.request.url.includes('/api/')) {
    // API requests: network only, fail with 503 + JSON so the app can show a friendly message
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: '离线模式：网络或代理不可用' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))
    );
  } else if (e.request.mode === 'navigate') {
    // HTML: network-first, so updated pages always reach the phone when online
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return r;
      }).catch(() => caches.match(e.request).then(r => r || new Response('离线模式', { status: 200 })))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).catch(() => new Response('离线模式', { status: 200 })))
    );
  }
});
