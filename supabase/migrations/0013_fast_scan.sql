-- Quét nhanh: chỉ lấy số theo giờ của chiến dịch rồi chạy luật trong ngày (tăng ngân sách khi tiêu nhanh).
-- Xen giữa các lần quét đầy đủ 15 phút:
--   cả ngày: mỗi 5 phút
--   0h–0h59 giờ VN (17h UTC, ngay sau reset, giờ bán mạnh nhất): thêm các phút chẵn còn lại → 2 phút/lần
select cron.schedule(
  'autopilot-collect-fast',
  '5,10,20,25,35,40,50,55 * * * *',
  $$select public.autopilot_call('/api/jobs/collect?fast=1')$$
);
select cron.schedule(
  'autopilot-collect-fast-0h',
  '2,4,6,8,12,14,16,18,22,24,26,28,32,34,36,38,42,44,46,48,52,54,56,58 17 * * *',
  $$select public.autopilot_call('/api/jobs/collect?fast=1')$$
);
