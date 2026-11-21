-- FB Magic Tool: bảng trần chi/doanh thu theo mã sản phẩm (anh hoặc Tài chính nhập).
-- Dòng product_code = '*' là mặc định cho mọi mã chưa có dòng riêng (trần lãi 20%, hòa vốn 36%).
create table if not exists public.fb_ceilings (
  product_code text primary key,
  profit_ceiling numeric not null check (profit_ceiling > 0 and profit_ceiling < 5),
  breakeven numeric not null check (breakeven > 0 and breakeven < 5),
  note text,
  updated_at timestamptz not null default now(),
  check (profit_ceiling <= breakeven)
);
insert into public.fb_ceilings (product_code, profit_ceiling, breakeven, note)
values ('*', 0.20, 0.36, 'Mặc định')
on conflict (product_code) do nothing;
alter table public.fb_ceilings enable row level security;
