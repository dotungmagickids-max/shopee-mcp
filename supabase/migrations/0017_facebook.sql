-- Nhân viên Facebook (giai đoạn 1: báo cáo + đề xuất).

-- Số theo quảng cáo × ngày: chi Meta + đơn Pancake gắn ad_id (CPAS: số mua Meta ghi nhận).
create table if not exists public.fb_ad_daily (
  ngay date not null,
  ad_id text not null,
  account_id text not null,
  account_name text,
  campaign_name text,
  adset_name text,
  ad_name text,
  spend numeric not null default 0,          -- số Meta, chưa nhân phí 1,111
  orders integer not null default 0,         -- đơn không hủy trên Pancake
  revenue numeric not null default 0,
  cpas boolean not null default false,
  meta_purchases integer not null default 0,
  meta_purchase_value numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ngay, ad_id)
);
create index if not exists fb_ad_daily_account on public.fb_ad_daily (account_id, ngay);

-- Đề xuất tắt / tăng gửi lên Telegram, kèm quyết định của anh.
create table if not exists public.fb_proposals (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  ngay date not null,
  kind text not null check (kind in ('pause', 'scale')),
  ad_id text not null,
  ad_name text,
  account_id text,
  account_name text,
  campaign_name text,
  reason text,
  status text not null default 'proposed' check (status in ('proposed', 'executed', 'failed', 'rejected', 'expired')),
  decided_at timestamptz,
  message_id bigint,
  target_level text,                          -- ad | adset | campaign: nơi đã sửa trên Meta
  target_id text,
  before jsonb,
  after jsonb,
  error text,
  unique (ad_id, kind, ngay)
);

create table if not exists public.fb_settings (
  id integer primary key default 1 check (id = 1),
  stopped boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.fb_settings (id) values (1) on conflict (id) do nothing;

alter table public.fb_ad_daily enable row level security;
alter table public.fb_proposals enable row level security;
alter table public.fb_settings enable row level security;
