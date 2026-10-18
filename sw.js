// Service worker: cho app chạy offline. Đổi số phiên bản khi cập nhật code.
const CACHE = 'sotay-v4';
const PHOTOS = 'sotay-photos';
const ASSETS = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== PHOTOS).map(k => caches.delete(k)))));
  self.clients.claim();
});

// Có mạng: lấy bản mới nhất. Mất mạng: dùng bản đã lưu.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Ảnh kỷ niệm: lưu lại trên máy, lần sau mở ngay (kể cả lúc không có mạng)
  if (/\/photo\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    e.respondWith(caches.open(PHOTOS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== self.location.origin) return; // bản đồ, phông chữ, máy chủ đồng bộ: để trình duyệt tự xử lý
  e.respondWith(
    // no-cache: luôn hỏi lại GitHub xem có bản mới không (bỏ qua bộ nhớ đệm 10 phút)
    fetch(e.request.url, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});

// Thông báo đẩy
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Sổ Tay', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Sổ Tay', { body: d.body || '', icon: 'icon-180.png', badge: 'icon-180.png', data: { url: './' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  }));
});
