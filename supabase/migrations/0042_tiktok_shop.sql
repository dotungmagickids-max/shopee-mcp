-- TikTok Shop (app "Magickids Gateway" trên TikTok Shop Partner Center, thị trường Việt Nam).
-- Mỗi lần ủy quyền (shop = Seller, kênh TikTok = Creator) là một dòng tiktok_accounts.
-- Token mã hóa bằng token-crypto (TOKEN_ENC_KEY). Bảng chỉ máy chủ đọc: bật RLS, không policy. Chạy lại được.

create table if not exists tiktok_accounts (
  open_id text primary key,
  user_type integer not null default 0,          -- 0 = seller (shop), 1 = creator (kênh TikTok)
  seller_name text,
  region text,
  access_token text not null,
  refresh_token text not null,
  access_expire_at bigint not null,              -- unix mili giây, đã trừ 1 phút dự phòng
  refresh_expire_at bigint,
  scopes jsonb,
  shops jsonb,                                   -- [{id, name, region, cipher, code, seller_type}] từ Get Authorized Shops
  refresh_lock_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tiktok_auth_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

alter table tiktok_accounts enable row level security;
alter table tiktok_auth_requests enable row level security;
