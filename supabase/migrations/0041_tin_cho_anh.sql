-- Hộp tin cho anh (Hải thêm 25/11/2026): anh không đọc Telegram nữa. Mỗi tin máy chủ gửi vào chat mặc định
-- (TELEGRAM_CHAT_ID) được lưu thêm ở đây; lịch "chuyen-tin-may-chu" đọc, gom, nhờ Minh Anh nhắn Zalo riêng anh,
-- rồi đánh dấu da_chuyen_at. Chạy lại được.
create table if not exists public.tin_cho_anh (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  nguon text not null default 'autopilot',
  noi_dung text not null,
  co_nut boolean not null default false,       -- tin có nút Đồng ý / Bỏ qua trên Telegram
  tg_message_id bigint,
  da_chuyen_at timestamptz
);
create index if not exists tin_cho_anh_chua_chuyen on public.tin_cho_anh (created_at) where da_chuyen_at is null;
alter table public.tin_cho_anh enable row level security;
