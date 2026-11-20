/* Trang quầy đóng hàng (/kho): luôn lấy bản mới nhất từ mạng; mất mạng thì mở bản đã lưu trên máy.
   Chỉ lưu chính trang đó. Không lưu dữ liệu đơn, không lưu lời gọi /api. */
const CACHE = "mk-kho-trang-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || r.mode !== "navigate") return;
  e.respondWith(
    fetch(r, { cache: "no-store" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("trang", copy));
        }
        return res;
      })
      .catch(() => caches.open(CACHE).then((c) => c.match("trang")).then((m) => m || Response.error()))
  );
});
