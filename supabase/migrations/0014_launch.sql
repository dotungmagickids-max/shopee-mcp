-- Thứ Hai 07:10 giờ VN (00:10 UTC): đề xuất lên quảng cáo mã chưa chạy + đánh giá hàng Mới đủ 14 ngày.
select cron.schedule(
  'autopilot-launch',
  '10 0 * * 1',
  $$select public.autopilot_call('/api/jobs/launch')$$
);
