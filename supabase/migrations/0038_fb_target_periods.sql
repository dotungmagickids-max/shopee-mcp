-- FB Magic Tool, màn Mục tiêu: mục tiêu chi theo khoảng ngày (vd tuần sale, ngày lễ). Ngày nằm trong một khoảng thì
-- dùng mục tiêu của khoảng đó thay cho mục tiêu ngày chung (bảng fb_targets). Tiền là chi thật (số Meta × 1,111).
create table if not exists public.fb_target_periods (
  id bigserial primary key,
  tu date not null,
  den date not null,
  day_budget numeric not null check (day_budget >= 0),                      -- chi thật mỗi ngày trong khoảng; 0 = nghỉ, không chạy
  ratio numeric check (ratio is null or (ratio > 0 and ratio <= 1)),       -- tỉ lệ riêng cho khoảng này; null = dùng tỉ lệ chung
  note text,
  updated_at timestamptz not null default now(),
  check (tu <= den)
);
create index if not exists fb_target_periods_tu on public.fb_target_periods (tu, den);
alter table public.fb_target_periods enable row level security;
