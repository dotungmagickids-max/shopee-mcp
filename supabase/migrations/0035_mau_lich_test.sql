-- Lịch test mẫu mới (tab "Lịch test" của trang /mau): ngày bắt đầu chạy test quảng cáo và việc chuẩn bị đã xong.
-- Hạn từng việc chuẩn bị không lưu ở đây: tính lùi từ ngày test, nên dời ngày test thì hạn tự dời theo. Chạy lại được.
alter table mau_ho_so add column if not exists ngay_test date;
-- { "<mục>": { "nguoi": "...", "luc": "..." } } cho các mục đã xong: thong_tin, ma_hang, hinh_anh, bai_ban.
alter table mau_ho_so add column if not exists chuan_bi jsonb not null default '{}'::jsonb;
create index if not exists mau_ho_so_ngay_test on mau_ho_so (ngay_test) where ngay_test is not null;
