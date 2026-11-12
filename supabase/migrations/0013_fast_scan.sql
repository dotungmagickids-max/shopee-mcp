-- Quét nhanh 5 phút lúc 20h–1h59 giờ VN (13h–18h59 UTC), xen giữa các lần quét 15 phút.
-- Chỉ lấy số theo giờ của chiến dịch rồi chạy luật trong ngày (tăng ngân sách khi tiêu nhanh).
select cron.schedule(
  'autopilot-collect-fast',
  '5,10,20,25,35,40,50,55 13-18 * * *',
  $$select public.autopilot_call('/api/jobs/collect?fast=1')$$
);
