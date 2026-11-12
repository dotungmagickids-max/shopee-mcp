-- Lý do tool không tăng ngân sách dù chiến dịch đã chạm ngân sách (cập nhật mỗi lần quét).
alter table ads_campaigns add column if not exists scale_block text;
alter table ads_campaigns add column if not exists scale_block_at timestamptz;
