-- Quản lý chất lượng CSKH: tin chat đọc từ Pancake (chỉ đọc), rút gọn để đo lượng tin, trả lời đầu, tin sót, tỉ lệ chốt.
-- KHÔNG lưu tên, SĐT, địa chỉ hay nội dung tin của khách. SĐT chỉ có dạng đã băm với muối bí mật của máy chủ, để khớp đơn POS.
-- Bảng chỉ dùng phía máy chủ (service role): bật RLS, không có policy. Chạy lại được nhiều lần.

-- Mỗi hội thoại một dòng.
create table if not exists cskh_hoi_thoai (
  page_id text not null,
  id text not null,
  loai text not null default 'INBOX',          -- INBOX | COMMENT | LIVESTREAM
  tao_luc timestamptz not null,
  cap_nhat_luc timestamptz not null,
  the text[] not null default '{}',            -- tên thẻ sale gắn
  co_sdt boolean not null default false,
  sdt_bam text[] not null default '{}',        -- SĐT đã băm, không đọc ngược được
  ad_ids text[] not null default '{}',
  so_tin integer not null default 0,
  dong_bo_luc timestamptz not null default now(),
  primary key (page_id, id)
);
create index if not exists cskh_hoi_thoai_cap_nhat on cskh_hoi_thoai (cap_nhat_luc);
create index if not exists cskh_hoi_thoai_sdt on cskh_hoi_thoai using gin (sdt_bam);

-- Mỗi tin một dòng, không có chữ.
create table if not exists cskh_tin (
  page_id text not null,
  hoi_thoai_id text not null,
  id text not null,
  luc timestamptz not null,
  ben text not null check (ben in ('khach', 'nhan_vien', 'tu_dong')),
  nhan_vien text,                              -- tên nhân viên gửi (không phải khách)
  ky_tu integer not null default 0,
  loai text not null default 'chu',            -- chu | anh | sticker | khac | rong
  ma text[] not null default '{}',             -- mã hàng, nhóm hàng nhắc tới trong tin
  bam text,                                    -- dấu băm phần chữ của tin shop, để nhận ra tin mẫu
  primary key (page_id, id)
);
create index if not exists cskh_tin_luc on cskh_tin (luc);
create index if not exists cskh_tin_hoi_thoai on cskh_tin (page_id, hoi_thoai_id, luc);

-- Đơn POS khớp với một cuộc chat (theo mã hội thoại ghi trên đơn, hoặc theo SĐT đã băm).
create table if not exists cskh_don_khop (
  ma_don text primary key,
  page_id text not null,
  hoi_thoai_id text not null,
  tao_luc timestamptz not null,
  trang_thai integer not null default 0,
  khop_bang text not null default 'hoi_thoai'  -- hoi_thoai | sdt
);
create index if not exists cskh_don_khop_tao on cskh_don_khop (tao_luc);

-- Bản chụp số đã tính của từng ngày (trang đọc từ đây cho nhanh; đổi định nghĩa thì tính lại).
create table if not exists cskh_ngay (
  ngay date primary key,
  du_lieu jsonb not null,
  tom_tat jsonb not null default '{}'::jsonb,
  tinh_luc timestamptz not null default now()
);

alter table cskh_hoi_thoai enable row level security;
alter table cskh_tin enable row level security;
alter table cskh_don_khop enable row level security;
alter table cskh_ngay enable row level security;
