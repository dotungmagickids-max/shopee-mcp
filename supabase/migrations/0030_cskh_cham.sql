-- Quản lý chất lượng CSKH, đợt 2: điểm AI chấm từng cuộc chat, phân loại, phản hồi xấu, việc nên làm với từng khách.
-- KHÔNG lưu nội dung chat, tên, SĐT, địa chỉ của khách. Các ô chữ (mo_ta_xau, viec, nhan_xet) do AI viết, đã che SĐT.
-- Khóa chính có cả model để chấm thử cùng một ngày bằng nhiều model rồi so.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy. Chạy lại được nhiều lần. Cần 0027_cskh.sql.

create table if not exists cskh_cham (
  ngay date not null,
  page_id text not null,
  hoi_thoai_id text not null,
  model text not null,
  loai text not null,                          -- hoi_gia_size | chot_don | hoi_ship | doi_tra | khieu_nai | hoi_don_da_dat | spam | khac
  ket_qua text not null,                       -- da_chot | xin_duoc_sdt | khach_im | ngoai_size | het_hang | dang_trao_doi | da_giai_quyet | khac
  diem_size smallint,                          -- 0–2, null khi không áp dụng
  diem_mua_kem smallint,
  diem_chot smallint,
  diem_thai_do smallint,
  san_pham text[] not null default '{}',       -- tên gọi hoặc mã sản phẩm khách hỏi
  phan_hoi_xau boolean not null default false,
  mo_ta_xau text not null default '',
  do_dong_hang boolean not null default false,
  viec text not null default '',               -- việc sale nên làm tiếp với khách này
  muc_gap smallint not null default 2,         -- 1 gấp, 2 trong ngày, 3 khi rảnh
  nhan_xet text not null default '',
  token_vao integer not null default 0,
  token_ra integer not null default 0,
  cham_luc timestamptz not null default now(),
  primary key (ngay, page_id, hoi_thoai_id, model)
);
create index if not exists cskh_cham_ngay_model on cskh_cham (ngay, model);

alter table cskh_cham enable row level security;
