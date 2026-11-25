-- FB Magic Tool, màn Lên camp: lưu mỗi lần bấm Tạo (cấu hình, bài, kết quả từng quảng cáo) để xem lại và tạo lại bài
-- lỗi sau khi tải lại trang. source = 'nhat_ky': lần lên camp cũ dựng lại từ nhật ký fb_write_log. Chạy lại được.
create table if not exists public.fb_launch_runs (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  page_id text,
  config jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  results jsonb not null default '[]'::jsonb,   -- [{post_id, ad_name, account_id, campaign_id, adset_id, ad_id, error, notes}]
  status text not null default 'dang_chay' check (status in ('dang_chay', 'xong')),
  source text not null default 'web' check (source in ('web', 'nhat_ky'))
);
create index if not exists fb_launch_runs_created on public.fb_launch_runs (created_at desc);
alter table public.fb_launch_runs enable row level security;
