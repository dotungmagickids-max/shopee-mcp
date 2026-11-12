-- Nhân viên Shopee giai đoạn A: đánh giá và việc chờ duyệt (trả lời đánh giá).

create table if not exists public.shop_reviews (
  comment_id text primary key,
  shop_id bigint not null,
  item_id bigint,
  order_sn text,
  rating integer not null,
  comment text,
  topic text,                 -- size | chat_luong | giao_hang | khac (chỉ đánh giá ≤ 3 sao)
  create_time timestamptz not null,
  replied boolean not null default false,
  reply text,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shop_reviews_shop_time on public.shop_reviews (shop_id, create_time desc);
create index if not exists shop_reviews_unreplied on public.shop_reviews (shop_id, rating) where not replied;

create table if not exists public.shop_tasks (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  shop_id bigint not null,
  kind text not null check (kind in ('reply_low', 'reply_batch')),
  payload jsonb not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed')),
  decided_at timestamptz,
  message_id bigint,
  error text
);
create index if not exists shop_tasks_status on public.shop_tasks (status, kind);

alter table public.shop_reviews enable row level security;
alter table public.shop_tasks enable row level security;
