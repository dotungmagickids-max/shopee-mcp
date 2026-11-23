-- FB Magic Tool, màn Bài đã đăng: mã sản phẩm anh gắn tay cho từng bài (khi chữ trong bài không ghi mã, hoặc ghi sai).
-- post_id dạng <page_id>_<post_id>. Dòng có codes rỗng coi như chưa nhập.
create table if not exists public.fb_post_codes (
  post_id text primary key,
  codes text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.fb_post_codes enable row level security;
