-- Yêu cầu trả hàng / hoàn tiền (returns.get_return_list), đồng bộ hằng đêm 45 ngày gần nhất.
create table if not exists shopee_returns (
  return_sn text primary key,
  shop_id bigint not null,
  order_sn text not null,
  status text,                -- REQUESTED / PROCESSING / JUDGING / SELLER_DISPUTE / ACCEPTED / CANCELLED / CLOSED
  refund_amount numeric,
  amount_before_discount numeric,
  needs_logistics boolean,    -- hàng gửi trả về shop
  return_solution smallint,   -- 0 trả hàng + hoàn tiền, 1 chỉ hoàn tiền
  reason text,
  text_reason text,
  items jsonb,                -- [{item_id, model_sku, qty, refund_amount, price}]
  create_time bigint,
  update_time bigint,
  synced_at timestamptz not null default now()
);
create index if not exists shopee_returns_shop_order_idx on shopee_returns (shop_id, order_sn);
create index if not exists shopee_returns_shop_time_idx on shopee_returns (shop_id, create_time);
alter table shopee_returns enable row level security;
