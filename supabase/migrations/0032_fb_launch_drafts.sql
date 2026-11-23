-- FB Magic Tool, màn Lên camp: kế hoạch lên camp lưu nháp (chưa tạo gì trên Meta). Anh mở lại để sửa hoặc tạo sau.
create table if not exists public.fb_launch_drafts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  name text not null,
  page_id text not null,
  config jsonb not null,           -- cấu hình chung (tài khoản, cấu trúc, ngân sách, tuổi, tên chiến dịch, tên nhóm, giờ hẹn)
  items jsonb not null             -- [{post_id, name}]: bài đã chọn và tên quảng cáo
);
create index if not exists fb_launch_drafts_page on public.fb_launch_drafts (page_id, created_at desc);
alter table public.fb_launch_drafts enable row level security;
