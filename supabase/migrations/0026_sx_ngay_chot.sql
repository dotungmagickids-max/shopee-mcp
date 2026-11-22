-- Sổ hàng xưởng: ngày chốt sản xuất và thông tin sản xuất của lô.
-- Ngày chốt là mốc để đo năng lực xưởng: chốt → cắt → về lần đầu → về đủ.
-- Chạy lại được nhiều lần. Cần 0025_san_xuat.sql chạy trước.

alter table sx_lo_cat add column if not exists ngay_chot date;       -- ngày chốt sản xuất với xưởng (mốc bắt đầu tính)
alter table sx_lo_cat add column if not exists xuong text;           -- đơn vị gia công
alter table sx_lo_cat add column if not exists ngay_vai_ve date;     -- ngày vải về xưởng
alter table sx_lo_cat add column if not exists thong_tin_sx text;    -- ghi tự do: in thêu, may, hoàn thiện, vướng gì…

-- Thêm cột ở CUỐI view (create or replace view không cho chen giữa).
-- ve_dau = ngày đầu tiên kho đếm được hàng; ve_du = ngày kho đếm đủ số cắt (null khi chưa đủ).
-- so_ngay_* tính từ ngày chốt; so_ngay_da_qua = từ ngày chốt đến hôm nay (giờ Việt Nam) khi lô chưa về đủ.
create or replace view sx_tien_do_lo with (security_invoker = true) as
select l.id as lo_id, l.ma_hang, l.lo, l.phieu_dat_id, l.ngay_cat, l.hen_tra, l.gia, l.trang_thai, l.ghi_chu,
  coalesce(t.so_cat, 0) as so_cat,
  coalesce(t.xuong_giao, 0) as xuong_giao,
  coalesce(t.kho_dem, 0) as kho_dem,
  coalesce(t.cho_kho_dem, 0) as cho_kho_dem,
  coalesce(t.so_cat, 0) - coalesce(t.kho_dem, 0) as con_no,
  case when l.trang_thai = 'dang_ve' and l.hen_tra is not null and coalesce(t.so_cat, 0) - coalesce(t.kho_dem, 0) > 0
    then greatest(0, (now() at time zone 'Asia/Ho_Chi_Minh')::date - l.hen_tra) else 0 end as ngay_tre,
  (select count(*)::int from sx_doi_hen d where d.lo_id = l.id) as so_lan_doi_hen,
  coalesce((select d.hen_cu from sx_doi_hen d where d.lo_id = l.id order by d.id limit 1), l.hen_tra) as hen_dau,
  (select max(h.ngay) from sx_hang_ve h where h.lo_id = l.id) as ve_gan_nhat,
  l.ngay_chot, l.xuong, l.ngay_vai_ve, l.thong_tin_sx,
  m.ve_dau, m.ve_du,
  l.ngay_cat - l.ngay_chot as so_ngay_chot_den_cat,
  m.ve_dau - l.ngay_chot as so_ngay_chot_den_ve_dau,
  m.ve_du - l.ngay_chot as so_ngay_chot_den_ve_du,
  case when l.ngay_chot is not null and m.ve_du is null
    then (now() at time zone 'Asia/Ho_Chi_Minh')::date - l.ngay_chot end as so_ngay_da_qua
from sx_lo_cat l
left join (
  select lo_id, sum(so_cat)::int as so_cat, sum(xuong_giao)::int as xuong_giao, sum(kho_dem)::int as kho_dem,
    sum(cho_kho_dem)::int as cho_kho_dem
  from sx_tien_do group by lo_id
) t on t.lo_id = l.id
left join lateral (
  select min(x.ngay) filter (where x.kho > 0) as ve_dau,
    min(x.ngay) filter (where coalesce(t.so_cat, 0) > 0 and x.luy_ke >= t.so_cat) as ve_du
  from (
    select n.ngay, n.kho, sum(n.kho) over (order by n.ngay) as luy_ke
    from (
      select h.ngay, sum(coalesce(d.kho_dem, 0))::int as kho
      from sx_hang_ve h join sx_hang_ve_dong d on d.hang_ve_id = h.id
      where h.lo_id = l.id group by h.ngay
    ) n
  ) x
) m on true;

revoke all on sx_tien_do_lo from anon, authenticated;

-- Ghi ngày chốt sản xuất và thông tin sản xuất của một lô ĐÃ CÓ. Trường nào bỏ trống thì giữ nguyên.
create or replace function public.mk_sx_lot_info(p_agent text, p_ma_hang text, p_lo text, p_nguon text,
  p_ngay_chot date default null, p_xuong text default null, p_ngay_vai_ve date default null,
  p_thong_tin_sx text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := coalesce(nullif(trim(p_agent), ''), 'khong_ro');
  src text := public.sx_can_nguon(p_nguon);
  ma text := upper(trim(coalesce(p_ma_hang, '')));
  l text := trim(coalesce(p_lo, ''));
  hom_nay date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  r sx_lo_cat; truoc jsonb;
begin
  select * into r from sx_lo_cat where ma_hang = ma and lo = l;
  if r.id is null then raise exception 'Không có lô % %. Tạo lô bằng mk_sx_lot_save trước', ma, l; end if;
  if p_ngay_chot is null and p_xuong is null and p_ngay_vai_ve is null and p_thong_tin_sx is null then
    raise exception 'Chưa có thông tin nào để ghi';
  end if;
  if p_ngay_chot > hom_nay then raise exception 'Ngày chốt sản xuất % ở tương lai', p_ngay_chot; end if;
  if p_ngay_vai_ve > hom_nay then raise exception 'Ngày vải về % ở tương lai', p_ngay_vai_ve; end if;
  if coalesce(p_ngay_chot, r.ngay_chot) > r.ngay_cat then
    raise exception 'Ngày chốt sản xuất % sau ngày cắt % của lô', coalesce(p_ngay_chot, r.ngay_chot), r.ngay_cat;
  end if;
  truoc := to_jsonb(r);
  update sx_lo_cat set
    ngay_chot = coalesce(p_ngay_chot, ngay_chot),
    xuong = coalesce(nullif(trim(p_xuong), ''), xuong),
    ngay_vai_ve = coalesce(p_ngay_vai_ve, ngay_vai_ve),
    thong_tin_sx = coalesce(nullif(trim(p_thong_tin_sx), ''), thong_tin_sx),
    sua_luc = now()
  where id = r.id returning * into r;
  insert into sx_nhat_ky (bang, ban_ghi_id, hanh_dong, truoc, sau, nguon, nguoi_ghi)
  values ('sx_lo_cat', r.id, 'sua', truoc, to_jsonb(r), src, a);
  perform public.sx_ghi_log(a, 'sx_lot_info', 'ghi', ma || ' ' || l);
  return jsonb_build_object('lo', (select to_jsonb(t) from sx_tien_do_lo t where t.lo_id = r.id));
end $$;

-- Chỉ service role (máy chủ) được gọi.
do $$
declare f text;
begin
  foreach f in array array[
    'mk_sx_lot_info(text,text,text,text,date,text,date,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
