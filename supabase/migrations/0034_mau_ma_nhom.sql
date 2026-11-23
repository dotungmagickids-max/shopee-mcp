-- Nhóm của mã ở tab "Mã bán tốt" (trang /mau): hot | deu (bán đều) | '' (chưa xếp). Người dùng tự chọn. Chạy lại được.
alter table mau_ma_ban add column if not exists nhom text not null default '';
