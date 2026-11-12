-- Lịch chạy autopilot bằng Supabase pg_cron + pg_net.
-- KHÔNG nằm trong migrations/ vì chứa JOB_SECRET: chạy tay một lần trong Supabase → SQL Editor.
--
-- 1. Database → Extensions: bật pg_cron và pg_net (hoặc chạy 2 dòng create extension dưới).
-- 2. Chạy cả file. JOB_SECRET được tạo ngẫu nhiên ngay trong Vault (không ai phải gõ tay),
--    rồi lấy ra đặt lên Vercel:
--      select decrypted_secret from vault.decrypted_secrets where name = 'autopilot_job_secret';
-- pg_cron trên Supabase chạy theo giờ UTC: 0h giờ VN = 17h UTC hôm trước.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Lưu secret trong Vault thay vì viết thẳng vào lệnh cron.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'autopilot_job_secret')
where not exists (select 1 from vault.secrets where name = 'autopilot_job_secret');

create or replace function public.autopilot_call(path text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://magickids-shopee.vercel.app' || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'autopilot_job_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
$$;
revoke all on function public.autopilot_call(text) from public, anon, authenticated;

-- Xóa lịch cũ (nếu chạy lại file này).
select cron.unschedule(jobname) from cron.job where jobname like 'autopilot-%';

select cron.schedule('autopilot-collect',      '*/15 * * * *', $$select public.autopilot_call('/api/jobs/collect')$$);
select cron.schedule('autopilot-daily-ads',    '0 18 * * *',   $$select public.autopilot_call('/api/jobs/daily?part=ads')$$);    -- 01:00 VN
select cron.schedule('autopilot-daily-orders', '5 18 * * *',   $$select public.autopilot_call('/api/jobs/daily?part=orders')$$); -- 01:05 VN
select cron.schedule('autopilot-daily-escrow', '10 18 * * *',  $$select public.autopilot_call('/api/jobs/daily?part=escrow')$$); -- 01:10 VN
select cron.schedule('autopilot-daily-costs',  '15 18 * * *',  $$select public.autopilot_call('/api/jobs/daily?part=costs')$$);  -- 01:15 VN (giá vốn Pancake + lãi)
select cron.schedule('autopilot-reset',       '0 17 * * *',   $$select public.autopilot_call('/api/jobs/reset')$$);             -- 00:00 VN
select cron.schedule('autopilot-daily-roas',   '20 18 * * *',  $$select public.autopilot_call('/api/jobs/daily?part=roas')$$);   -- 01:20 VN
select cron.schedule('autopilot-refresh',      '0 0 * * 1',    $$select public.autopilot_call('/api/jobs/refresh')$$);           -- Thứ Hai 07:00 VN
select cron.schedule('autopilot-report',     '0 1 * * *',    $$select public.autopilot_call('/api/jobs/report')$$);            -- 08:00 VN

-- Chăm shop (giai đoạn A): phút 40 mỗi giờ 8h–22h VN; báo cáo tuần thứ Hai 08:15 VN.
select cron.schedule('autopilot-care',        '40 1-15 * * *', $$select public.autopilot_call('/api/jobs/care')$$);
select cron.schedule('autopilot-care-weekly', '15 1 * * 1',    $$select public.autopilot_call('/api/jobs/care-weekly')$$);

-- Dọn bảng phụ hằng tuần (giữ 30 ngày job_runs, 14 ngày snapshot ví, 7 ngày phản hồi pg_net).
select cron.schedule('autopilot-cleanup', '30 19 * * 0', $$
  delete from public.job_runs where started_at < now() - interval '30 days';
  delete from public.ads_balance_snapshots where created_at < now() - interval '14 days';
  delete from net._http_response where created < now() - interval '7 days';
$$);

-- Kiểm tra: select * from cron.job; select * from cron.job_run_details order by start_time desc limit 20;
