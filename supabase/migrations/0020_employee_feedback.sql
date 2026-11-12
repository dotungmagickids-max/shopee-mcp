-- "Sai vì…": lý do anh bỏ qua đề xuất của nhân viên AI, dùng để rà và chỉnh luật hằng tuần.
create table if not exists public.employee_feedback (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  bot text not null check (bot in ('facebook', 'shopee')),
  ref_kind text not null,          -- fb_proposal | autopilot_action | shop_task
  ref_id bigint not null,
  proposal text,                   -- tóm tắt đề xuất bị bỏ qua
  ask_message_id bigint,           -- tin hỏi "Sai vì…" trên Telegram
  reason text,                     -- câu anh trả lời
  answered_at timestamptz
);
create index if not exists employee_feedback_ask on public.employee_feedback (bot, ask_message_id);
create index if not exists employee_feedback_time on public.employee_feedback (created_at desc);
alter table public.employee_feedback enable row level security;
