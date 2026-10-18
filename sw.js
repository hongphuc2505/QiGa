// Service worker: cho app chạy offline. Đổi số phiên bản khi cập nhật code.
const CACHE = 'sotay-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Có mạng: lấy bản mới nhất. Mất mạng: dùng bản đã lưu.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    // no-cache: luôn hỏi lại GitHub xem có bản mới không (bỏ qua bộ nhớ đệm 10 phút)
    fetch(e.request.url, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
