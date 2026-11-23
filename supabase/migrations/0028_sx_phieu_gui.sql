-- Phiếu xưởng gửi đối tác (đặt vải, đặt in thêu, giao may), soạn ở trang /xuong.
-- Lưu nguyên nội dung phiếu để máy nào của xưởng cũng mở lại, sửa và in được.
-- KHÔNG lưu đơn giá: máy chủ bỏ đơn giá trước khi ghi (xem src/lib/xuong-phieu.ts).
-- Chạy lại được nhiều lần.

create table if not exists sx_phieu_gui (
  id bigint generated always as identity primary key,
  so text not null,                                     -- số phiếu, vd DV-261123-01
  loai text not null check (loai in ('vai', 'in', 'may')),
  ngay date not null,                                   -- ngày lập
  doi_tac text not null,
  ma_hang text not null default '',
  lo text not null default '',
  noi_dung jsonb not null,                              -- toàn bộ phiếu đã kiểm, không có đơn giá
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now(),
  sua_luc timestamptz not null default now(),
  xoa_luc timestamptz                                   -- xóa mềm: giữ dòng, không hiện nữa
);
-- Số phiếu không trùng trong các phiếu còn dùng; phiếu đã xóa nhả số.
create unique index if not exists sx_phieu_gui_so_idx on sx_phieu_gui (so) where xoa_luc is null;
create index if not exists sx_phieu_gui_ngay_idx on sx_phieu_gui (ngay desc, id desc);

-- Chỉ máy chủ (service role) đọc ghi; bật RLS và không có policy nào.
alter table sx_phieu_gui enable row level security;
revoke all on sx_phieu_gui from anon, authenticated;
grant select, insert, update on sx_phieu_gui to service_role;
