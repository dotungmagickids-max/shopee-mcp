-- Tab "Mã bán tốt" của trang /mau: danh sách mã tham khảo để làm content, DO NGƯỜI DÙNG TỰ QUẢN.
-- Không đồng bộ tự động: mã được thêm tay (hoặc nạp một lần từ số đã có), số bán chỉ cập nhật khi quản lý bấm.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy. Chạy lại được nhiều lần.
create table if not exists mau_ma_ban (
  ma text primary key,                -- mã hàng, viết hoa
  ten text not null default '',
  gioi text not null default '' check (gioi in ('', 'trai', 'gai', 'unisex')),
  loai text not null default '',
  mua text not null default '',
  nam integer,                        -- năm ra mã
  anh_url text,                       -- ảnh lấy lúc thêm mã (nếu có); ảnh tự đăng nằm ở mau_ma_anh
  sl_ban integer not null default 0,  -- số cái đã bán trong năm `nam_ban`, chụp lúc `so_ban_luc`
  nam_ban integer,
  so_ban_luc timestamptz,
  nguon text not null default 'tay',  -- tay | pancake
  an boolean not null default false,  -- ẩn khỏi tab (ví dụ hàng xả)
  ly_do_an text not null default '',
  nguoi text not null default '',
  cap_nhat_luc timestamptz not null default now()
);

-- Ảnh tự đăng cho từng mã (đã thu nhỏ ở trình duyệt). Có ảnh ở đây thì dùng thay ảnh lấy lúc thêm mã.
create table if not exists mau_ma_anh (
  ma text primary key,
  kieu text not null check (kieu in ('image/jpeg', 'image/png', 'image/webp')),
  du_lieu text not null,              -- base64
  nguoi text not null default '',
  cap_nhat_luc timestamptz not null default now()
);

alter table mau_ma_ban enable row level security;
alter table mau_ma_anh enable row level security;
