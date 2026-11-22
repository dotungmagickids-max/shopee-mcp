-- FB Magic Tool: nhật ký mọi lệnh ghi lên Meta (tạo camp, sau này: bật/tắt, đổi ngân sách, nhân bản).
create table if not exists public.fb_write_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  action text not null,            -- create_campaign | create_adset | create_creative | create_ad | ...
  account_id text,
  target_id text,                  -- id đối tượng trên Meta (nếu tạo được)
  target_name text,
  before jsonb,                    -- giá trị cũ (lệnh tạo thì null)
  after jsonb,                     -- giá trị mới / tham số đã gửi
  ok boolean not null,
  error text
);
create index if not exists fb_write_log_created on public.fb_write_log (created_at desc);
alter table public.fb_write_log enable row level security;
