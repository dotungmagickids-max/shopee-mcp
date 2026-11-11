-- Siết ngân sách thay cho tạm dừng (chiến dịch tạm dừng thì Shopee không cho sửa). Idempotent.
alter table ads_campaigns add column if not exists throttled_at timestamptz;     -- lúc tool siết ngân sách
alter table ads_campaigns add column if not exists restore_budget numeric;       -- ngân sách sẽ nới lại
