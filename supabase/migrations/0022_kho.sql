-- Phần mềm quay đóng hàng của kho: đưa dữ liệu vận hành lên máy chủ để xem từ xa và để AI nhập đơn theo lệnh.
-- KHÔNG lưu video ở đây (video nằm ở thư mục máy kho / Google Drive), chỉ lưu danh sách đơn, sổ video và ghi chú.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy.

-- Danh sách đơn cần đóng (cũng là danh sách soát đơn) theo ngày.
create table if not exists kho_don (
  ngay date not null,
  ma text not null,
  nguon text,
  tao_luc timestamptz not null default now(),
  primary key (ngay, ma)
);

-- Ghi chú dạng khóa → JSON:
--   pham_vi 'soat:YYYY-MM-DD'  khoa = mã đơn      du_lieu = { lyDo, xuLy }
--   pham_vi 'hoan'             khoa = mã kiện      du_lieu = { state, note, at }
--   pham_vi 'ngay-reset'       khoa = YYYY-MM-DD   du_lieu = { at }  (lần gần nhất danh sách ngày đó bị thay/xóa)
create table if not exists kho_ghi_chu (
  pham_vi text not null,
  khoa text not null,
  du_lieu jsonb not null default '{}'::jsonb,
  cap_nhat timestamptz not null default now(),
  primary key (pham_vi, khoa)
);

-- Sổ video: mỗi video đóng hàng / hàng hoàn một dòng (không có nội dung video).
create table if not exists kho_video (
  file text primary key,
  ma text not null,
  ma_don text,
  so_don text,
  che_do text not null,
  bat_dau timestamptz not null,
  giay numeric,
  kich_thuoc bigint,
  soat text,
  kenh text,
  loai_ma text,
  may text,
  da_xoa boolean not null default false,
  cap_nhat timestamptz not null default now()
);
create index if not exists kho_video_bat_dau_idx on kho_video (bat_dau desc);

alter table kho_don enable row level security;
alter table kho_ghi_chu enable row level security;
alter table kho_video enable row level security;
