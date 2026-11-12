-- Cải tiến liên tục (anh chốt 13/11/2026): không cố định lãi 10%, mỗi chiến dịch Chủ lực / Thường tự thử
-- từng bậc lãi mong muốn (lên / xuống), đo tiền lãi thật mỗi ngày của sản phẩm, giữ bậc cho tiền lãi cao hơn.

-- Bậc lãi mong muốn đang dùng của chiến dịch (null = theo nhóm hàng).
alter table ads_campaigns add column if not exists profit_level_pct numeric;

-- Nhật ký thử bậc: mỗi lần thử một dòng.
create table if not exists profit_steps (
  id bigserial primary key,
  shop_id bigint not null,
  campaign_id bigint not null,
  cls text,
  direction text not null,          -- down (lãi % thấp hơn, bán nhiều hơn) | up
  from_pct numeric not null,
  to_pct numeric not null,
  from_roas numeric,
  to_roas numeric,
  status text not null default 'running', -- running | kept | reverted | stopped
  started_on date not null,
  decided_on date,
  base jsonb,                        -- số ngày nền: ngày, lãi/ngày, doanh số/ngày, chi/ngày
  result jsonb,                      -- số ngày thử + kết luận
  note text,
  created_at timestamptz not null default now()
);
create index if not exists profit_steps_camp on profit_steps (shop_id, campaign_id, started_on desc);
create index if not exists profit_steps_status on profit_steps (shop_id, status);
alter table profit_steps enable row level security;

-- 01:30 giờ VN (sau giá vốn 01:15 và ROAS 01:20): chấm bậc đang thử, mở bậc mới.
do $$ begin
  perform cron.unschedule('autopilot-steps');
exception when others then null;
end $$;
select cron.schedule(
  'autopilot-steps',
  '30 18 * * *',
  $$select public.autopilot_call('/api/jobs/daily?part=steps')$$
);
