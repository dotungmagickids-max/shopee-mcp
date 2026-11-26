-- TikTok Content Posting API (app "Magickids Content" trên developers.tiktok.com):
-- đẩy video vào hộp nháp (inbox) của kênh TikTok để nhân viên gắn sản phẩm rồi đăng trong app TikTok.
-- Token mã hóa bằng token-crypto. Bảng chỉ máy chủ đọc: bật RLS, không policy. Chạy lại được.

create table if not exists tiktok_content_users (
  open_id text primary key,
  display_name text,
  avatar_url text,
  access_token text not null,
  refresh_token text not null,
  access_expire_at bigint not null,
  refresh_expire_at bigint,
  scopes text,
  refresh_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tiktok_content_jobs (
  id uuid primary key default gen_random_uuid(),
  open_id text,
  publish_id text,
  source_url text,
  note text,
  status text not null,
  detail jsonb,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists tiktok_content_jobs_created_idx on tiktok_content_jobs (created_at desc);

alter table tiktok_content_users enable row level security;
alter table tiktok_content_jobs enable row level security;
