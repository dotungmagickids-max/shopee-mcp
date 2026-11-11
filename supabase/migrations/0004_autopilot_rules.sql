-- Ads Autopilot giai đoạn 2: luật, đề xuất có duyệt, thực thi. Idempotent.

alter table autopilot_settings add column if not exists rule_params jsonb not null default '{}';
alter table autopilot_settings add column if not exists reset_unlimited boolean not null default false;
alter table autopilot_settings add column if not exists sale_dates date[] not null default '{}';
alter table autopilot_settings add column if not exists halt_reason text;

-- Chiến dịch: loại khỏi tự động; đánh dấu bị tool tạm dừng (để 0h bật lại).
alter table ads_campaigns add column if not exists autopilot_excluded boolean not null default false;
alter table ads_campaigns add column if not exists tool_paused_at timestamptz;

-- Đề xuất nhóm (reset 0h, ROAS hằng ngày, pause_all…): dòng cha + các dòng con.
alter table autopilot_actions add column if not exists parent_id bigint references autopilot_actions (id) on delete cascade;
alter table autopilot_actions add column if not exists expires_at timestamptz;
alter table autopilot_actions add column if not exists telegram_message_id bigint;
alter table autopilot_actions add column if not exists decided_by text;
create index if not exists autopilot_actions_parent_idx on autopilot_actions (parent_id);
create index if not exists autopilot_actions_campaign_idx on autopilot_actions (shop_id, campaign_id, created_at desc);

-- Trạng thái 'group' cho dòng cha.
alter table autopilot_actions drop constraint if exists autopilot_actions_status_check;
alter table autopilot_actions add constraint autopilot_actions_status_check
  check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed', 'dry_run', 'expired', 'skipped'));
