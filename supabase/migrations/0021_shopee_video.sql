-- Shopee Video: a separate Open Platform app ("Shopee Video Management") whose
-- video.* APIs are User-level (access_token + user_id, not shop_id).
-- Server-only tables, RLS on, no policies.

create table if not exists video_users (
  env text not null check (env in ('test', 'live')),
  user_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  expired_at bigint not null,
  refresh_lock_until timestamptz,
  label text,
  updated_at timestamptz not null default now(),
  primary key (env, user_id)
);

create table if not exists video_auth_requests (
  id uuid primary key default gen_random_uuid(),
  env text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- Every upload / edit / post, for the /video page and audit.
create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  env text not null,
  user_id bigint,
  video_upload_id text,
  source_url text,
  caption text,
  item_ids bigint[],
  status text not null,
  detail jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists video_jobs_created_idx on video_jobs (created_at desc);

alter table video_users enable row level security;
alter table video_auth_requests enable row level security;
alter table video_jobs enable row level security;
