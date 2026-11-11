-- OAuth 2.1 layer in front of /api/mcp, so OAuth-only MCP clients (claude.ai custom
-- connectors, Claude mobile/desktop apps) can connect. The seller proves access by
-- pasting one or more existing smcp_ API keys on the consent page; the issued tokens
-- inherit those keys' shops and access level. Server-only tables, RLS on, no policies.

-- Dynamically registered clients (RFC 7591). Public clients only (PKCE, no secret).
create table if not exists oauth_clients (
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

-- Single-use authorization codes (stored hashed), valid for a few minutes.
create table if not exists oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients (client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  api_key_ids uuid[] not null,
  resource text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Access and refresh tokens (stored hashed). Refresh tokens rotate on use.
create table if not exists oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('access', 'refresh')),
  client_id text not null references oauth_clients (client_id) on delete cascade,
  api_key_ids uuid[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table oauth_clients enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
