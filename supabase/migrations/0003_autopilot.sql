-- Magickids Ads Autopilot, giai đoạn 1: số liệu quảng cáo, đơn hàng, cấu hình, nhật ký.
-- Chỉ server (service role) truy cập: bật RLS, không có policy.
-- Idempotent: chạy lại nhiều lần không sao.

-- Khóa refresh token (tránh 2 job refresh cùng lúc làm hỏng chuỗi refresh_token).
alter table shopee_tokens add column if not exists refresh_lock_until timestamptz;

-- Cấu hình chiến dịch mới nhất (làm mới mỗi giờ).
create table if not exists ads_campaigns (
  shop_id bigint not null,
  campaign_id bigint not null,
  ad_type text,
  ad_name text,
  bidding_method text,
  campaign_placement text,
  campaign_status text,
  campaign_budget numeric,          -- 0 = không giới hạn
  roas_target numeric,
  item_ids bigint[],
  start_time bigint,
  end_time bigint,
  updated_at timestamptz not null default now(),
  primary key (shop_id, campaign_id)
);

-- Lịch sử cấu hình: chỉ ghi khi trạng thái / ngân sách / ROAS mục tiêu thay đổi.
create table if not exists ads_campaign_history (
  id bigint generated always as identity primary key,
  shop_id bigint not null,
  campaign_id bigint not null,
  campaign_status text,
  campaign_budget numeric,
  roas_target numeric,
  observed_at timestamptz not null default now()
);
create index if not exists ads_campaign_history_idx on ads_campaign_history (shop_id, campaign_id, observed_at desc);

-- Hiệu quả theo giờ từng chiến dịch. date = ngày giờ Việt Nam.
create table if not exists ads_campaign_hourly (
  shop_id bigint not null,
  campaign_id bigint not null,
  date date not null,
  hour smallint not null,
  impression bigint not null default 0,
  clicks bigint not null default 0,
  expense numeric not null default 0,
  broad_order integer not null default 0,
  broad_gmv numeric not null default 0,
  direct_order integer not null default 0,
  direct_gmv numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, campaign_id, date, hour)
);
create index if not exists ads_campaign_hourly_date_idx on ads_campaign_hourly (shop_id, date);

-- Hiệu quả theo giờ toàn shop (mọi quảng cáo CPC).
create table if not exists ads_shop_hourly (
  shop_id bigint not null,
  date date not null,
  hour smallint not null,
  impression bigint not null default 0,
  clicks bigint not null default 0,
  expense numeric not null default 0,
  broad_order integer not null default 0,
  broad_gmv numeric not null default 0,
  direct_order integer not null default 0,
  direct_gmv numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, date, hour)
);

-- Hiệu quả theo ngày chiến dịch GMV Max cấp shop.
create table if not exists ads_gms_daily (
  shop_id bigint not null,
  campaign_id bigint not null,
  date date not null,
  impression bigint not null default 0,
  clicks bigint not null default 0,
  expense numeric not null default 0,
  broad_order integer not null default 0,
  broad_gmv numeric not null default 0,
  direct_order integer not null default 0,
  direct_gmv numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (shop_id, campaign_id, date)
);

create table if not exists ads_balance_snapshots (
  id bigint generated always as identity primary key,
  shop_id bigint not null,
  total_balance numeric not null,
  data_time timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ads_balance_snapshots_idx on ads_balance_snapshots (shop_id, created_at desc);

-- Đơn hàng (create_time = giây unix). items: [{item_id, model_id, item_sku, model_sku, qty, price}].
create table if not exists orders (
  shop_id bigint not null,
  order_sn text primary key,
  create_time bigint not null,
  order_status text,
  total_amount numeric,
  items jsonb,
  detail_fetched_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists orders_shop_time_idx on orders (shop_id, create_time);

-- Tiền về từng đơn (escrow). raw giữ phần order_income để đối chiếu sau.
create table if not exists order_escrow (
  order_sn text primary key,
  shop_id bigint not null,
  escrow_amount numeric,
  buyer_total_amount numeric,
  commission_fee numeric,
  service_fee numeric,
  seller_transaction_fee numeric,
  ams_commission_fee numeric,
  withholding_tax numeric,
  shopee_discount numeric,
  voucher_from_shopee numeric,
  refund_amount numeric,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists sku_costs (
  shop_id bigint not null,
  sku text not null,
  cost numeric not null,
  updated_at timestamptz not null default now(),
  primary key (shop_id, sku)
);

-- Cài đặt từng shop. mode mặc định 'suggest'. Trần cứng dùng ở giai đoạn 2.
create table if not exists autopilot_settings (
  shop_id bigint primary key,
  shop_name text,
  mode text not null default 'suggest' check (mode in ('off', 'suggest', 'auto')),
  emergency_stop boolean not null default false,
  daily_cap_normal numeric,         -- tổng ngân sách tối đa/ngày (ngày thường)
  daily_cap_sale numeric,           -- tổng ngân sách tối đa/ngày (ngày sale)
  campaign_cap numeric,             -- ngân sách tối đa mỗi chiến dịch
  max_increase_pct numeric not null default 30,
  max_edits_per_day integer not null default 6,
  start_budget numeric not null default 100000,
  reset_hour smallint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists autopilot_rules (
  id bigint generated always as identity primary key,
  shop_id bigint not null,
  campaign_id bigint,               -- null = mặc định toàn shop
  kind text not null,
  params jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists autopilot_actions (
  id bigint generated always as identity primary key,
  shop_id bigint not null,
  campaign_id bigint,
  action text not null,             -- change_budget, change_roas_target, pause, resume
  before jsonb,
  after jsonb,
  reason text,
  source text not null,             -- 'rule:<id>', 'admin', 'telegram'
  reference_id uuid not null unique default gen_random_uuid(),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed', 'dry_run', 'expired')),
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  executed_at timestamptz
);
create index if not exists autopilot_actions_idx on autopilot_actions (shop_id, created_at desc);

-- Mỗi lần chạy job: dùng để kiểm tra "không mất giờ nào".
create table if not exists job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  shop_id bigint,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  error text,
  stats jsonb
);
create index if not exists job_runs_idx on job_runs (job, started_at desc);

-- Chống gửi trùng cảnh báo Telegram.
create table if not exists alert_state (
  key text primary key,
  last_sent_at timestamptz not null default now(),
  payload jsonb
);

-- Tổng hợp theo ngày. security_invoker để view tuân theo RLS (không lộ dữ liệu qua anon key).
create or replace view ads_campaign_daily with (security_invoker = true) as
  select shop_id, campaign_id, date,
    sum(impression) as impression, sum(clicks) as clicks, sum(expense) as expense,
    sum(broad_order) as broad_order, sum(broad_gmv) as broad_gmv,
    sum(direct_order) as direct_order, sum(direct_gmv) as direct_gmv
  from ads_campaign_hourly group by shop_id, campaign_id, date;

create or replace view ads_shop_daily with (security_invoker = true) as
  select shop_id, date,
    sum(impression) as impression, sum(clicks) as clicks, sum(expense) as expense,
    sum(broad_order) as broad_order, sum(broad_gmv) as broad_gmv,
    sum(direct_order) as direct_order, sum(direct_gmv) as direct_gmv
  from ads_shop_hourly group by shop_id, date;

revoke all on ads_campaign_daily, ads_shop_daily from anon, authenticated;

insert into autopilot_settings (shop_id, shop_name) values
  (92907330, 'Magickids'),
  (971643674, 'Annie Baby - Váy bé gái')
on conflict (shop_id) do nothing;

alter table ads_campaigns enable row level security;
alter table ads_campaign_history enable row level security;
alter table ads_campaign_hourly enable row level security;
alter table ads_shop_hourly enable row level security;
alter table ads_gms_daily enable row level security;
alter table ads_balance_snapshots enable row level security;
alter table orders enable row level security;
alter table order_escrow enable row level security;
alter table sku_costs enable row level security;
alter table autopilot_settings enable row level security;
alter table autopilot_rules enable row level security;
alter table autopilot_actions enable row level security;
alter table job_runs enable row level security;
alter table alert_state enable row level security;
