-- Ảnh đại diện của biến thể (đường dẫn ảnh đầu tiên trên Pancake POS), để trang /mau hiện hình các mã đang bán.
-- Bộ đồng bộ đêm điền cột này; trước lần đồng bộ đầu cột để trống. Chạy lại được nhiều lần.
alter table pancake_variations add column if not exists image_url text;
