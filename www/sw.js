// Service Worker for offline caching
const CACHE = 'russian-app-v66';
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
    // 静态资源 cache-first；离线且不在缓存时：HTML 回兜底文本，其余回 503 JSON
    // （audit I-2：此前一律 200 "离线模式"，JS/CSS/JSON 会以语法错误形式失败）
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).catch(() => {
        if (e.request.destination === 'document' || /\.html?(\?|$)/.test(e.request.url)) {
          return new Response('离线模式', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        return new Response(JSON.stringify({ error: '离线：该资源不可用' }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }))
    );
  }
});
