-- Giá vốn + tồn kho theo biến thể, đồng bộ hằng đêm từ Pancake POS.
-- sku = mã biến thể Pancake (display_id), viết hoa, bỏ khoảng trắng; trùng model_sku trên Shopee.
create table if not exists pancake_variations (
  sku text primary key,
  product_name text,
  cost numeric,          -- giá nhập bình quân (average_imported_price)
  last_cost numeric,     -- giá nhập gần nhất
  retail_price numeric,
  stock integer,         -- tồn có thể bán, cộng mọi kho
  selling_avg numeric,   -- tốc độ bán/ngày theo Pancake
  updated_at timestamptz not null default now()
);
alter table pancake_variations enable row level security;

-- Kinh tế từng chiến dịch (tính hằng đêm): giá bán TB, tỉ lệ giá vốn, ROAS hòa vốn, ROAS cần cho lãi mong muốn.
alter table ads_campaigns add column if not exists econ jsonb;

-- Tóm tắt của shop (phí Shopee thật theo escrow, tỉ lệ hủy/hoàn, số TB shop) để hiển thị trên dashboard.
alter table autopilot_settings add column if not exists econ_summary jsonb;
