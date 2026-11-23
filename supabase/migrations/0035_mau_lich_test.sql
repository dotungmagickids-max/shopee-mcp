-- Lịch test mẫu mới (tab "Lịch test" của trang /mau): ngày bắt đầu chạy test quảng cáo, việc chuẩn bị đã xong,
-- và kế hoạch, kịch bản bán hàng của đợt test.
-- Hạn từng việc chuẩn bị không lưu ở đây: tính lùi từ ngày test, nên dời ngày test thì hạn tự dời theo. Chạy lại được.
alter table mau_ho_so add column if not exists ngay_test date;
-- { "<mục>": { "nguoi": "...", "luc": "..." } } cho các mục đã xong: thong_tin, ke_hoach, bai_ban.
alter table mau_ho_so add column if not exists chuan_bi jsonb not null default '{}'::jsonb;
-- { gia_ban, tien_test, chi_so, dang_bai, chot_khach }: mỗi mục là một đoạn chữ.
alter table mau_ho_so add column if not exists ke_hoach_test jsonb not null default '{}'::jsonb;
create index if not exists mau_ho_so_ngay_test on mau_ho_so (ngay_test) where ngay_test is not null;
