-- Web quản trị, trang "Hôm nay" (/admin/hom-nay): một hàm CHỈ ĐỌC gom các số nằm trong ngăn core,
-- vì ngăn core không mở ra API (máy chủ chỉ gọi được hàm public.mk_*).
-- Chỉ trả số đếm: không có tên, SĐT, địa chỉ khách, không có nội dung việc hay đề xuất.
-- Chạy lại nhiều lần vẫn an toàn. Cần ngăn core của repo magickids-backup (db/migrations 0001, 0005, 0021).

-- plpgsql để file chạy được cả khi chưa có ngăn core (thân hàm chỉ kiểm lúc gọi).
create or replace function public.mk_web_hom_nay() returns jsonb
language plpgsql stable security definer set search_path = core, public as $$
begin
  return jsonb_build_object(
    -- Việc còn mở theo người làm
    'viec', coalesce((
      select jsonb_agg(jsonb_build_object('nguoi', assignee, 'mo', mo, 'tre', tre, 'gap', gap))
      from (
        select assignee, count(*) as mo,
          count(*) filter (where due < (now() at time zone 'Asia/Ho_Chi_Minh')::date) as tre,
          count(*) filter (where priority = 1) as gap
        from core.team_tasks where status in ('moi', 'dang_lam', 'cham') group by assignee
      ) t), '[]'::jsonb),
    -- Đề xuất chờ anh duyệt, gom theo phòng và loại việc
    'de_xuat', coalesce((
      select jsonb_agg(jsonb_build_object('phong', agent, 'viec', action, 'so', so, 'cu_nhat', cu_nhat))
      from (
        select agent, action, count(*) as so, min(created_at) as cu_nhat
        from core.proposals where status = 'cho_duyet' group by agent, action
      ) p), '[]'::jsonb),
    -- Lần đồng bộ gần nhất của từng nguồn ghi vào core.sync_runs
    'dong_bo', coalesce((
      select jsonb_agg(jsonb_build_object('job', job, 'lan_cuoi', lan_cuoi, 'lan_cuoi_ok', lan_cuoi_ok, 'ok', ok))
      from (
        select job, max(started_at) as lan_cuoi, max(finished_at) filter (where ok) as lan_cuoi_ok,
          (array_agg(coalesce(ok, false) order by started_at desc))[1] as ok
        from core.sync_runs group by job
      ) s), '[]'::jsonb),
    -- Đơn Pancake: mới đến lúc nào, và đơn còn mở (mới, đang xử lý, chờ hàng) 60 ngày gần đây
    'don_pancake', jsonb_build_object(
      'den', (select max(created_at) from core.orders),
      'dong_bo_luc', (select max(synced_at) from core.orders),
      'mo', coalesce((
        select jsonb_agg(jsonb_build_object('kenh', channel, 'trang_thai', status_name, 'so', so, 'cu_nhat', cu_nhat))
        from (
          select channel, status_name, count(*) as so, min(ngay) as cu_nhat
          from core.orders_v
          where status_std in ('moi', 'dang_xu_ly') and created_at >= now() - interval '60 days'
          group by channel, status_name
        ) o), '[]'::jsonb))
  );
end $$;

revoke all on function public.mk_web_hom_nay() from public, anon, authenticated;
grant execute on function public.mk_web_hom_nay() to service_role;
