-- Mã sản phẩm, danh mục, ngày tạo từ Pancake (để phân nhóm hàng: mới / xả kho / chủ lực / thường).
alter table pancake_variations add column if not exists product_code text;      -- vd QD26001 (display_id sản phẩm)
alter table pancake_variations add column if not exists categories text[];      -- vd {Bé trai, Thu đông}
alter table pancake_variations add column if not exists product_created timestamptz;
create index if not exists pancake_variations_code_idx on pancake_variations (product_code);

-- Nhóm hàng anh chọn tay cho từng sản phẩm Shopee (ghi đè phân loại tự động).
create table if not exists product_classes (
  shop_id bigint not null,
  item_id bigint not null,
  manual_class text check (manual_class in ('chu_luc', 'thuong', 'xa_kho', 'moi')),
  updated_at timestamptz not null default now(),
  primary key (shop_id, item_id)
);
alter table product_classes enable row level security;
