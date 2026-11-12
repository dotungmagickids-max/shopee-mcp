-- Vòng đời sản phẩm (ma trận BCG): mỗi mã đang bán một dòng, cập nhật hằng tuần.
create table if not exists product_lifecycle (
  shop_id bigint not null,
  item_id bigint not null,
  name text,
  image text,
  price numeric,
  stock integer,
  days_of_stock integer,
  units7 integer not null default 0,
  units30 integer not null default 0,
  cost_ratio numeric,
  breakeven numeric,
  profit_pct numeric,
  profit_source text,               -- qc | tiem_nang
  in_ads boolean not null default false,
  campaign_ids bigint[] not null default '{}',
  ad_spend14 numeric not null default 0,
  ad_gmv14 numeric not null default 0,
  ad_impr14 bigint not null default 0,
  ad_clicks14 bigint not null default 0,
  ad_orders14 integer not null default 0,
  views bigint,
  sold_total bigint,
  rating numeric,
  comments integer,
  image_count integer,
  has_video boolean,
  desc_len integer,
  cls text not null,                -- chu_luc | thuong | xa_kho | moi
  cls_source text,                  -- manual | auto | chua_qc
  suggested_cls text,
  suggest_reason text,
  problems text[] not null default '{}',
  upgrades text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (shop_id, item_id)
);
create index if not exists product_lifecycle_cls on product_lifecycle (shop_id, cls);

-- Ảnh chụp tuần: lượt xem / đã bán luỹ kế để tính chênh lệch tuần sau.
create table if not exists product_snapshots (
  shop_id bigint not null,
  item_id bigint not null,
  date date not null,
  views bigint,
  sold_total bigint,
  rating numeric,
  comments integer,
  units30 integer,
  primary key (shop_id, item_id, date)
);

alter table product_lifecycle enable row level security;
alter table product_snapshots enable row level security;

-- Chủ nhật 23:40 UTC = thứ Hai 06:40 giờ VN (trước job lên quảng cáo 07:10).
select cron.schedule(
  'autopilot-lifecycle',
  '40 23 * * 0',
  $$select public.autopilot_call('/api/jobs/lifecycle')$$
);
