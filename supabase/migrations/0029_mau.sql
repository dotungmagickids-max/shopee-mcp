-- Mẫu và media (trang /mau), đợt 1: danh sách mẫu đang xem / chọn làm / đã có media / bỏ, hồ sơ từng mẫu, nhật ký.
-- Ảnh, video KHÔNG nằm ở đây: hồ sơ chỉ giữ đường dẫn thư mục lưu trữ bên ngoài và một ảnh đại diện nhỏ.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy. Chạy lại được nhiều lần.

create table if not exists mau_ho_so (
  id bigint generated always as identity primary key,
  ma text not null unique,                      -- mã tạm của mẫu (viết hoa), dùng tới khi cho sản xuất
  ma_chinh_thuc text,                           -- mã hàng chính thức, cấp khi cho sản xuất
  ten text not null default '',
  thuong_hieu text not null default '',
  gioi text not null default '' check (gioi in ('', 'trai', 'gai', 'unisex')),
  loai text not null default '',                -- áo, quần, bộ, váy…
  mua text not null default '',                 -- mùa / đợt bán dự kiến
  nguon_loai text not null default 'taobao' check (nguon_loai in ('taobao', 'suu_tam', 'xuong', 'tu_thiet_ke', 'ma_cu')),
  nguon_link text not null default '',
  nguon_shop text not null default '',
  thong_tin_nguon text not null default '',
  phan_tich text not null default '',
  ly_do text not null default '',               -- lý do chọn
  chat_lieu text not null default '',
  mau_sac text not null default '',
  bang_size text not null default '',
  co_mau_that boolean not null default false,
  ngay_mau_ve date,
  gia_ban text not null default '',             -- giá bán dự kiến
  gia_nhap text not null default '',            -- giá nhập / giá sản xuất: chỉ vai quản lý đọc được
  link_goc text not null default '',            -- thư mục ảnh, video nguồn chưa sửa
  link_anh text not null default '',            -- thư mục ảnh đã chỉnh
  link_video text not null default '',
  link_shopee text not null default '',
  so_anh integer not null default 0 check (so_anh >= 0),
  so_video integer not null default 0 check (so_video >= 0),
  sua_tt text not null default 'chua_giao' check (sua_tt in ('chua_giao', 'dang_lam', 'cho_duyet', 'da_duyet')),
  sua_nguoi text not null default '',
  sua_yeu_cau text not null default '',
  sua_xong date,
  mo_ta text not null default '',               -- mô tả cơ bản để tư vấn, viết bài
  luu_y text not null default '',               -- điều chưa xác minh, không được cam kết
  -- Đợt 1 dùng 4 trạng thái đầu; các trạng thái test, sản xuất khai sẵn để đợt sau không phải đổi ràng buộc.
  trang_thai text not null default 'dang_xem'
    check (trang_thai in ('dang_xem', 'chon_lam', 'co_media', 'test_1', 'test_2', 'cho_san_xuat', 'dang_ban', 'bo')),
  ly_do_bo text not null default '',
  nguoi_tao text not null default '',
  tao_luc timestamptz not null default now(),
  cap_nhat_luc timestamptz not null default now()
);
create index if not exists mau_ho_so_trang_thai on mau_ho_so (trang_thai, cap_nhat_luc desc);

-- Ảnh đại diện nhỏ (đã thu nhỏ ở trình duyệt), tách bảng để danh sách không phải kéo theo ảnh.
create table if not exists mau_anh (
  ho_so_id bigint primary key references mau_ho_so (id) on delete cascade,
  kieu text not null check (kieu in ('image/jpeg', 'image/png', 'image/webp')),
  du_lieu text not null,                        -- base64
  cap_nhat_luc timestamptz not null default now()
);

create table if not exists mau_nhat_ky (
  id bigint generated always as identity primary key,
  ho_so_id bigint not null references mau_ho_so (id) on delete cascade,
  luc timestamptz not null default now(),
  nguoi text not null,
  vai text not null,                            -- quan_ly | lam
  viec text not null,                           -- tao | sua | trang_thai | anh
  tu text not null default '',
  den text not null default '',
  ghi_chu text not null default ''
);
create index if not exists mau_nhat_ky_ho_so on mau_nhat_ky (ho_so_id, luc desc);

alter table mau_ho_so enable row level security;
alter table mau_anh enable row level security;
alter table mau_nhat_ky enable row level security;
