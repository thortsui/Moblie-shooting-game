/**
 * Service Worker — 快取策略：
 *  - 同源檔案（遊戲本體）：網路優先，離線時用快取 → 更新永遠即時
 *  - 跨源檔案（CDN 函式庫、AI 模型權重）：快取優先 → 第二次開啟不用重新下載模型
 */
const CACHE = 'pgf-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (sameOrigin) {
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw new Error('offline');
      }
    } else {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }
  })());
});
