-- Mã không đưa vào tab "Mã đang bán" của trang /mau (ví dụ hàng xả): quản lý ẩn hoặc hiện lại từng mã ngay trên trang.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy. Chạy lại được nhiều lần.
create table if not exists mau_ma_an (
  ma text primary key,                -- mã hàng, viết hoa
  ly_do text not null default '',
  nguoi text not null default '',
  luc timestamptz not null default now()
);
alter table mau_ma_an enable row level security;

-- Ảnh tự đăng cho từng mã ở tab "Mã đang bán" (đã thu nhỏ ở trình duyệt). Có ảnh ở đây thì dùng thay ảnh lấy từ Pancake.
create table if not exists mau_ma_anh (
  ma text primary key,
  kieu text not null check (kieu in ('image/jpeg', 'image/png', 'image/webp')),
  du_lieu text not null,              -- base64
  nguoi text not null default '',
  cap_nhat_luc timestamptz not null default now()
);
alter table mau_ma_anh enable row level security;
