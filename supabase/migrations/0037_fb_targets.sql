-- FB Magic Tool, màn Mục tiêu: mục tiêu chi quảng cáo Facebook của anh (một dòng duy nhất, id = 1).
-- Tiền là chi thật (số Meta × 1,111), trừ ad_budget là số Meta của một quảng cáo mới.
create table if not exists public.fb_targets (
  id integer primary key default 1 check (id = 1),
  month_budget numeric check (month_budget is null or month_budget > 0),   -- mục tiêu chi thật cả tháng
  day_budget numeric check (day_budget is null or day_budget > 0),         -- mục tiêu chi thật mỗi ngày; null = chia từ mục tiêu tháng
  ratio numeric not null default 0.2 check (ratio > 0 and ratio <= 1),     -- mục tiêu chi thật / doanh thu
  ad_budget numeric not null default 65000 check (ad_budget > 0),          -- ngân sách/ngày (số Meta) của một quảng cáo mới
  updated_at timestamptz not null default now()
);
insert into public.fb_targets (id) values (1) on conflict (id) do nothing;
alter table public.fb_targets enable row level security;
