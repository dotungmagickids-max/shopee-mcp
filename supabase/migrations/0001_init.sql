-- Shopee MCP demo schema.
-- All tables are accessed only from the server with the service role key,
-- so RLS is enabled with no policies (anon/authenticated roles get nothing).

-- Pending "Connect shop" attempts. The id travels through Shopee's redirect.
create table if not exists auth_requests (
  id uuid primary key default gen_random_uuid(),
  region text not null,
  access text not null check (access in ('read', 'read_write')),
  label text,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- One Shopee token pair per (region, shop). Refreshed automatically by the SDK.
create table if not exists shopee_tokens (
  region text not null,
  shop_id bigint not null,
  access_token text not null,
  refresh_token text not null,
  expired_at bigint not null, -- unix epoch milliseconds
  updated_at timestamptz not null default now(),
  primary key (region, shop_id)
);

-- MCP API keys. Only the SHA-256 hash of the key is stored.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  key_prefix text not null,
  label text,
  access text not null check (access in ('read', 'read_write')),
  region text not null,
  shop_ids bigint[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Every Shopee call made through the MCP server.
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  api_key_id uuid references api_keys (id) on delete set null,
  shop_id bigint,
  endpoint text not null,
  access text not null,
  ok boolean not null,
  error text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_api_key_id_created_at_idx on audit_log (api_key_id, created_at desc);

alter table auth_requests enable row level security;
alter table shopee_tokens enable row level security;
alter table api_keys enable row level security;
alter table audit_log enable row level security;
