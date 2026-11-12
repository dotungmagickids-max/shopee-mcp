-- Thử giá (anh chốt 13/11/2026): tool tự đổi giá khuyến mãi ±5%, tối đa 3 mã cùng lúc, không chờ duyệt,
-- đo tiền lãi/ngày rồi giữ hoặc trả giá cũ; báo việc đã làm và kết quả trong báo cáo 8h.
create table if not exists price_tests (
  id bigserial primary key,
  shop_id bigint not null,
  item_id bigint not null,
  name text,
  campaign_ids bigint[] not null default '{}',
  cls text,
  direction text not null,           -- down | up
  pct numeric not null,
  discount_id bigint not null,
  models jsonb not null,             -- [{model_id, old, new}]
  status text not null default 'running', -- running | kept | reverted | stopped
  started_on date not null,
  decided_on date,
  base jsonb,
  result jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists price_tests_item on price_tests (shop_id, item_id, started_on desc);
create index if not exists price_tests_status on price_tests (shop_id, status);
alter table price_tests enable row level security;
