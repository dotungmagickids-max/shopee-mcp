-- Sổ hàng xưởng (mục "Sản xuất" của web quản trị, trang /san-xuat).
-- Phiếu đặt → lô cắt (số cắt thật) → lần hàng về (xưởng giao, kho đếm, người ký, phiếu Pancake) → tiến độ.
-- Luật: ghi đúng theo lô; còn nợ = số cắt − số KHO ĐẾM (không phải số xưởng giao);
--       chỉ ghi số phiếu Pancake khi kho đã đếm đủ và có người ký.
-- Không có gì ở đây ghi sang Pancake/Shopee/Meta. Bảng chỉ dùng phía máy chủ (service role): bật RLS, không policy.
-- Người ghi là phòng Thu Hà qua công cụ MCP mk_sx_*; mỗi lần ghi phải có nguồn (msgId Zalo, số phiếu xưởng, ảnh chữ ký kho).
-- Các bảng "_dong" (màu × size) đi theo bản ghi cha: nguồn, người ghi, thời điểm ghi nằm ở bản ghi cha.

-- ============ BẢNG ============

-- Phiếu đặt hàng xưởng. `dot` phân biệt các phiếu của cùng một mã (vd 'L2', '17/11'); một phiếu một mã thì để ''.
create table if not exists sx_phieu_dat (
  id bigint generated always as identity primary key,
  ma_hang text not null,
  dot text not null default '',
  ngay_dat date,
  gia numeric check (gia is null or gia >= 0),          -- đ/cái
  ngay_du_kien_cat date,
  trang_thai text not null default 'cho_cat' check (trang_thai in ('cho_cat', 'da_cat', 'huy')),
  ghi_chu text,
  nguon text not null,
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now(),
  sua_luc timestamptz not null default now(),
  unique (ma_hang, dot)
);

-- Số đặt màu × size. Chưa chia màu hoặc size thì để ''.
create table if not exists sx_phieu_dat_dong (
  phieu_id bigint not null references sx_phieu_dat (id) on delete cascade,
  mau text not null default '',
  size text not null default '',
  so_luong int not null check (so_luong >= 0),
  primary key (phieu_id, mau, size)
);

-- Lô cắt: số cắt thật của xưởng.
--   trang_thai 'dang_ve'        đang chờ xưởng trả
--              'chua_doi_soat'  chỉ có số theo sổ xưởng, kho chưa đếm đối chiếu (không tính nợ, không tính trễ)
--              'dong'           đóng lô (đủ, hoặc xưởng không trả phần thiếu nữa)
create table if not exists sx_lo_cat (
  id bigint generated always as identity primary key,
  ma_hang text not null,
  lo text not null,
  phieu_dat_id bigint references sx_phieu_dat (id) on delete set null,
  ngay_cat date,
  hen_tra date,                                         -- ngày hẹn trả hiện tại; đổi qua mk_sx_lot_reschedule
  gia numeric check (gia is null or gia >= 0),
  trang_thai text not null default 'dang_ve' check (trang_thai in ('dang_ve', 'chua_doi_soat', 'dong')),
  ghi_chu text,
  nguon text not null,
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now(),
  sua_luc timestamptz not null default now(),
  unique (ma_hang, lo)
);

create table if not exists sx_lo_cat_dong (
  lo_id bigint not null references sx_lo_cat (id) on delete cascade,
  mau text not null default '',
  size text not null default '',
  so_cat int not null check (so_cat >= 0),
  primary key (lo_id, mau, size)
);

-- Lịch sử dời ngày hẹn trả: mỗi lần dời một dòng, không sửa không xóa.
create table if not exists sx_doi_hen (
  id bigint generated always as identity primary key,
  lo_id bigint not null references sx_lo_cat (id) on delete cascade,
  hen_cu date,
  hen_moi date not null,
  ly_do text not null,
  nguon text not null,
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now()
);
create index if not exists sx_doi_hen_lo_idx on sx_doi_hen (lo_id, id);

-- Lần hàng về: một phiếu giao của xưởng cho một lô trong một ngày.
--   so_phieu_pancake   số phiếu nhập Pancake (chỉ là số tham chiếu; ở đây không ghi gì sang Pancake)
--   khong_nhap_pancake true = lần này không nhập (vd đã nhập trước ở phiếu khác)
--   cả hai trống       = chưa nhập
create table if not exists sx_hang_ve (
  id bigint generated always as identity primary key,
  lo_id bigint not null references sx_lo_cat (id) on delete restrict,
  ngay date not null,
  so_phieu_xuong text,
  nguoi_ky text,                                        -- người của kho ký nhận
  so_phieu_pancake text,
  khong_nhap_pancake boolean not null default false,
  ghi_chu text,
  nguon text not null,
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now(),
  sua_luc timestamptz not null default now(),
  check (not (khong_nhap_pancake and so_phieu_pancake is not null))
);
create index if not exists sx_hang_ve_lo_idx on sx_hang_ve (lo_id, ngay);
create index if not exists sx_hang_ve_ngay_idx on sx_hang_ve (ngay desc);

-- kho_dem trống = kho chưa đếm (chưa tính là đã về).
create table if not exists sx_hang_ve_dong (
  hang_ve_id bigint not null references sx_hang_ve (id) on delete cascade,
  mau text not null default '',
  size text not null default '',
  xuong_giao int check (xuong_giao is null or xuong_giao >= 0),
  kho_dem int check (kho_dem is null or kho_dem >= 0),
  primary key (hang_ve_id, mau, size),
  check (xuong_giao is not null or kho_dem is not null)
);

-- Nhật ký sửa: bản trước và bản sau của mỗi lần ghi (để lần lại khi số bị sửa).
create table if not exists sx_nhat_ky (
  id bigint generated always as identity primary key,
  bang text not null,
  ban_ghi_id bigint not null,
  hanh_dong text not null,                              -- them | sua | doi_hen
  truoc jsonb,
  sau jsonb,
  nguon text not null,
  nguoi_ghi text not null,
  ghi_luc timestamptz not null default now()
);
create index if not exists sx_nhat_ky_ban_ghi_idx on sx_nhat_ky (bang, ban_ghi_id, id);

alter table sx_phieu_dat enable row level security;
alter table sx_phieu_dat_dong enable row level security;
alter table sx_lo_cat enable row level security;
alter table sx_lo_cat_dong enable row level security;
alter table sx_doi_hen enable row level security;
alter table sx_hang_ve enable row level security;
alter table sx_hang_ve_dong enable row level security;
alter table sx_nhat_ky enable row level security;

-- ============ VIEW TIẾN ĐỘ ============

-- Theo lô × màu × size. Màu so khớp không phân biệt hoa thường.
-- security_invoker: người gọi qua API vẫn bị RLS của bảng gốc chặn.
create or replace view sx_tien_do with (security_invoker = true) as
with cat as (
  select lo_id, lower(mau) as k_mau, size, min(mau) as mau, sum(so_cat)::int as so_cat
  from sx_lo_cat_dong group by lo_id, lower(mau), size
), ve as (
  select h.lo_id, lower(d.mau) as k_mau, d.size, min(d.mau) as mau,
    sum(coalesce(d.xuong_giao, 0))::int as xuong_giao,
    sum(coalesce(d.kho_dem, 0))::int as kho_dem,
    sum(case when d.kho_dem is null then coalesce(d.xuong_giao, 0) else 0 end)::int as cho_kho_dem
  from sx_hang_ve h join sx_hang_ve_dong d on d.hang_ve_id = h.id
  group by h.lo_id, lower(d.mau), d.size
), gop as (
  select coalesce(c.lo_id, v.lo_id) as lo_id, coalesce(c.mau, v.mau) as mau, coalesce(c.size, v.size) as size,
    coalesce(c.so_cat, 0) as so_cat, coalesce(v.xuong_giao, 0) as xuong_giao,
    coalesce(v.kho_dem, 0) as kho_dem, coalesce(v.cho_kho_dem, 0) as cho_kho_dem
  from cat c full join ve v on v.lo_id = c.lo_id and v.k_mau = c.k_mau and v.size = c.size
)
select l.id as lo_id, l.ma_hang, l.lo, g.mau, g.size, g.so_cat, g.xuong_giao, g.kho_dem, g.cho_kho_dem,
  g.so_cat - g.kho_dem as con_no,
  l.hen_tra, l.trang_thai
from gop g join sx_lo_cat l on l.id = g.lo_id;

-- Theo lô. ngay_tre = số ngày quá hẹn trả (giờ Việt Nam) khi lô đang về mà còn nợ; còn lại là 0.
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
  (select max(h.ngay) from sx_hang_ve h where h.lo_id = l.id) as ve_gan_nhat
from sx_lo_cat l
left join (
  select lo_id, sum(so_cat)::int as so_cat, sum(xuong_giao)::int as xuong_giao, sum(kho_dem)::int as kho_dem,
    sum(cho_kho_dem)::int as cho_kho_dem
  from sx_tien_do group by lo_id
) t on t.lo_id = l.id;

revoke all on sx_tien_do, sx_tien_do_lo from anon, authenticated;

-- ============ HÀM PHỤ ============

-- Ghi core.ai_audit_log nếu database có schema core (Bản đồ); không có thì bỏ qua, sx_nhat_ky vẫn ghi.
create or replace function public.sx_ghi_log(p_agent text, p_tool text, p_access text, p_summary text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('core.mk_log(text,text,text,text)') is not null then
    execute 'select core.mk_log($1, $2, $3, $4)' using p_agent, p_tool, p_access, left(p_summary, 300);
  end if;
end $$;

create or replace function public.sx_can_nguon(p_nguon text) returns text
language plpgsql set search_path = public as $$
begin
  if length(trim(coalesce(p_nguon, ''))) < 3 then
    raise exception 'Thiếu nguồn: ghi msgId Zalo, số phiếu xưởng hoặc ảnh chữ ký kho';
  end if;
  return left(trim(p_nguon), 500);
end $$;

-- Đọc mảng dòng màu × size: [{ "mau": "Đỏ", "size": "140", "<cột 1>": 10, "<cột 2>": 10 }, …].
-- Số phải nguyên, không âm; không trùng màu × size; mỗi dòng phải có ít nhất một số.
create or replace function public.sx_doc_dong(p_lines jsonb, p_cot text[])
returns table (mau text, size text, v1 int, v2 int)
language plpgsql set search_path = public as $$
declare
  e jsonb; n numeric; vals int[]; i int; da_co text[] := '{}'; khoa text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Thiếu các dòng màu × size';
  end if;
  for e in select x from jsonb_array_elements(p_lines) as j(x) loop
    mau := trim(coalesce(e ->> 'mau', ''));
    size := trim(coalesce(e ->> 'size', ''));
    khoa := lower(mau) || '|' || size;
    if khoa = any (da_co) then
      raise exception 'Trùng dòng màu "%" size "%"', mau, size;
    end if;
    da_co := da_co || khoa;
    vals := array[null, null]::int[];
    for i in 1 .. array_length(p_cot, 1) loop
      if (e ? p_cot[i]) and jsonb_typeof(e -> p_cot[i]) <> 'null' then
        begin
          n := (e ->> p_cot[i])::numeric;
        exception when others then
          raise exception 'Số "%" của màu "%" size "%" không hợp lệ', e ->> p_cot[i], mau, size;
        end;
        if n < 0 or n <> trunc(n) or n > 1000000 then
          raise exception 'Số "%" của màu "%" size "%" phải là số nguyên không âm', e ->> p_cot[i], mau, size;
        end if;
        vals[i] := n::int;
      end if;
    end loop;
    if vals[1] is null and vals[2] is null then
      raise exception 'Dòng màu "%" size "%" thiếu số lượng', mau, size;
    end if;
    v1 := vals[1];
    v2 := vals[2];
    return next;
  end loop;
end $$;

-- ============ GHI: PHIẾU ĐẶT ============

-- Thêm hoặc sửa theo khóa (mã hàng, đợt). Sửa: tham số để trống thì giữ số cũ; có p_lines thì thay toàn bộ dòng.
create or replace function public.mk_sx_order_save(p_agent text, p_ma_hang text, p_nguon text, p_dot text default '',
  p_lines jsonb default null, p_ngay_dat date default null, p_gia numeric default null,
  p_ngay_du_kien_cat date default null, p_trang_thai text default null, p_ghi_chu text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := coalesce(nullif(trim(p_agent), ''), 'khong_ro');
  src text := public.sx_can_nguon(p_nguon);
  ma text := upper(trim(coalesce(p_ma_hang, '')));
  d text := trim(coalesce(p_dot, ''));
  r sx_phieu_dat; truoc jsonb; sau jsonb; them boolean := false;
begin
  if ma = '' then raise exception 'Thiếu mã hàng'; end if;
  select * into r from sx_phieu_dat where ma_hang = ma and dot = d;
  if r.id is null then
    if p_lines is null then raise exception 'Phiếu đặt mới phải có số lượng màu × size'; end if;
    insert into sx_phieu_dat (ma_hang, dot, ngay_dat, gia, ngay_du_kien_cat, trang_thai, ghi_chu, nguon, nguoi_ghi)
    values (ma, d, p_ngay_dat, p_gia, p_ngay_du_kien_cat, coalesce(p_trang_thai, 'cho_cat'), p_ghi_chu, src, a)
    returning * into r;
    them := true;
  else
    truoc := to_jsonb(r) || jsonb_build_object('dong',
      (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_phieu_dat_dong x where x.phieu_id = r.id));
    update sx_phieu_dat set
      ngay_dat = coalesce(p_ngay_dat, ngay_dat), gia = coalesce(p_gia, gia),
      ngay_du_kien_cat = coalesce(p_ngay_du_kien_cat, ngay_du_kien_cat),
      trang_thai = coalesce(p_trang_thai, trang_thai), ghi_chu = coalesce(p_ghi_chu, ghi_chu),
      nguon = src, nguoi_ghi = a, sua_luc = now()
    where id = r.id returning * into r;
  end if;
  if p_lines is not null then
    delete from sx_phieu_dat_dong where phieu_id = r.id;
    insert into sx_phieu_dat_dong (phieu_id, mau, size, so_luong)
    select r.id, x.mau, x.size, x.v1 from public.sx_doc_dong(p_lines, array['so_luong']) x;
  end if;
  sau := to_jsonb(r) || jsonb_build_object('dong',
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_phieu_dat_dong x where x.phieu_id = r.id));
  insert into sx_nhat_ky (bang, ban_ghi_id, hanh_dong, truoc, sau, nguon, nguoi_ghi)
  values ('sx_phieu_dat', r.id, case when them then 'them' else 'sua' end, truoc, sau, src, a);
  perform public.sx_ghi_log(a, 'sx_order_save', 'ghi', ma || ' ' || d);
  return sau || jsonb_build_object(
    'so_dat', (select coalesce(sum(so_luong), 0) from sx_phieu_dat_dong where phieu_id = r.id),
    'da_them_moi', them);
end $$;

-- ============ GHI: LÔ CẮT ============

-- Thêm hoặc sửa theo khóa (mã hàng, lô). Ngày hẹn trả: đặt lần đầu ở đây; đã có rồi muốn đổi phải dùng
-- mk_sx_lot_reschedule để lưu lịch sử. p_dot_dat nối lô với phiếu đặt cùng mã.
create or replace function public.mk_sx_lot_save(p_agent text, p_ma_hang text, p_lo text, p_nguon text,
  p_lines jsonb default null, p_ngay_cat date default null, p_hen_tra date default null, p_gia numeric default null,
  p_dot_dat text default null, p_trang_thai text default null, p_ghi_chu text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := coalesce(nullif(trim(p_agent), ''), 'khong_ro');
  src text := public.sx_can_nguon(p_nguon);
  ma text := upper(trim(coalesce(p_ma_hang, '')));
  l text := trim(coalesce(p_lo, ''));
  r sx_lo_cat; pd bigint; truoc jsonb; sau jsonb; them boolean := false;
begin
  if ma = '' or l = '' then raise exception 'Thiếu mã hàng hoặc tên lô (ghi đúng theo lô)'; end if;
  if p_dot_dat is not null then
    select id into pd from sx_phieu_dat where ma_hang = ma and dot = trim(p_dot_dat);
    if pd is null then raise exception 'Không có phiếu đặt % đợt "%"', ma, trim(p_dot_dat); end if;
  end if;
  select * into r from sx_lo_cat where ma_hang = ma and lo = l;
  if r.id is null then
    if p_lines is null then raise exception 'Lô cắt mới phải có số cắt thật màu × size'; end if;
    insert into sx_lo_cat (ma_hang, lo, phieu_dat_id, ngay_cat, hen_tra, gia, trang_thai, ghi_chu, nguon, nguoi_ghi)
    values (ma, l, pd, p_ngay_cat, p_hen_tra, p_gia, coalesce(p_trang_thai, 'dang_ve'), p_ghi_chu, src, a)
    returning * into r;
    them := true;
  else
    if p_hen_tra is not null and r.hen_tra is not null and p_hen_tra <> r.hen_tra then
      raise exception 'Lô % % đang hẹn trả %. Đổi ngày hẹn phải dùng mk_sx_lot_reschedule để lưu lịch sử', ma, l, r.hen_tra;
    end if;
    truoc := to_jsonb(r) || jsonb_build_object('dong',
      (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_lo_cat_dong x where x.lo_id = r.id));
    update sx_lo_cat set
      phieu_dat_id = coalesce(pd, phieu_dat_id), ngay_cat = coalesce(p_ngay_cat, ngay_cat),
      hen_tra = coalesce(hen_tra, p_hen_tra), gia = coalesce(p_gia, gia),
      trang_thai = coalesce(p_trang_thai, trang_thai), ghi_chu = coalesce(p_ghi_chu, ghi_chu),
      nguon = src, nguoi_ghi = a, sua_luc = now()
    where id = r.id returning * into r;
  end if;
  if p_lines is not null then
    delete from sx_lo_cat_dong where lo_id = r.id;
    insert into sx_lo_cat_dong (lo_id, mau, size, so_cat)
    select r.id, x.mau, x.size, x.v1 from public.sx_doc_dong(p_lines, array['so_cat']) x;
  end if;
  sau := to_jsonb(r) || jsonb_build_object('dong',
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_lo_cat_dong x where x.lo_id = r.id));
  insert into sx_nhat_ky (bang, ban_ghi_id, hanh_dong, truoc, sau, nguon, nguoi_ghi)
  values ('sx_lo_cat', r.id, case when them then 'them' else 'sua' end, truoc, sau, src, a);
  perform public.sx_ghi_log(a, 'sx_lot_save', 'ghi', ma || ' ' || l);
  return jsonb_build_object('da_them_moi', them,
    'lo', (select to_jsonb(t) from sx_tien_do_lo t where t.lo_id = r.id));
end $$;

-- Đổi ngày hẹn trả, lưu lịch sử (hẹn cũ, hẹn mới, lý do, nguồn).
create or replace function public.mk_sx_lot_reschedule(p_agent text, p_ma_hang text, p_lo text, p_hen_moi date,
  p_ly_do text, p_nguon text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := coalesce(nullif(trim(p_agent), ''), 'khong_ro');
  src text := public.sx_can_nguon(p_nguon);
  ma text := upper(trim(coalesce(p_ma_hang, '')));
  l text := trim(coalesce(p_lo, ''));
  r sx_lo_cat;
begin
  if p_hen_moi is null then raise exception 'Thiếu ngày hẹn mới'; end if;
  if length(trim(coalesce(p_ly_do, ''))) < 3 then raise exception 'Thiếu lý do dời hẹn'; end if;
  select * into r from sx_lo_cat where ma_hang = ma and lo = l;
  if r.id is null then raise exception 'Không có lô % %', ma, l; end if;
  if r.hen_tra is not null and r.hen_tra = p_hen_moi then
    raise exception 'Ngày hẹn mới trùng ngày hẹn hiện tại (%)', r.hen_tra;
  end if;
  insert into sx_doi_hen (lo_id, hen_cu, hen_moi, ly_do, nguon, nguoi_ghi)
  values (r.id, r.hen_tra, p_hen_moi, trim(p_ly_do), src, a);
  update sx_lo_cat set hen_tra = p_hen_moi, sua_luc = now() where id = r.id;
  insert into sx_nhat_ky (bang, ban_ghi_id, hanh_dong, truoc, sau, nguon, nguoi_ghi)
  values ('sx_lo_cat', r.id, 'doi_hen', jsonb_build_object('hen_tra', r.hen_tra),
    jsonb_build_object('hen_tra', p_hen_moi, 'ly_do', trim(p_ly_do)), src, a);
  perform public.sx_ghi_log(a, 'sx_lot_reschedule', 'ghi',
    ma || ' ' || l || ': ' || coalesce(r.hen_tra::text, 'chưa hẹn') || ' → ' || p_hen_moi::text);
  return jsonb_build_object('lo', (select to_jsonb(t) from sx_tien_do_lo t where t.lo_id = r.id),
    'doi_hen', (select coalesce(jsonb_agg(jsonb_build_object('hen_cu', h.hen_cu, 'hen_moi', h.hen_moi, 'ly_do', h.ly_do,
      'nguon', h.nguon, 'nguoi_ghi', h.nguoi_ghi, 'ghi_luc', h.ghi_luc) order by h.id), '[]')
      from sx_doi_hen h where h.lo_id = r.id));
end $$;

-- ============ GHI: LẦN HÀNG VỀ ============

-- Thêm (không có p_id: cần mã hàng, lô, ngày, dòng) hoặc sửa (có p_id: tham số trống giữ số cũ, có p_lines thì thay dòng).
-- Dòng: { mau, size, xuong_giao, kho_dem }; kho chưa đếm thì bỏ trống kho_dem.
-- Số phiếu Pancake chỉ nhận khi mọi dòng đã có kho_dem và có người ký.
create or replace function public.mk_sx_arrival_save(p_agent text, p_nguon text, p_id bigint default null,
  p_ma_hang text default null, p_lo text default null, p_ngay date default null, p_lines jsonb default null,
  p_so_phieu_xuong text default null, p_nguoi_ky text default null, p_pancake text default null,
  p_khong_nhap boolean default null, p_ghi_chu text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a text := coalesce(nullif(trim(p_agent), ''), 'khong_ro');
  src text := public.sx_can_nguon(p_nguon);
  ma text := upper(trim(coalesce(p_ma_hang, '')));
  l text := trim(coalesce(p_lo, ''));
  pk text := nullif(trim(leading '#' from trim(coalesce(p_pancake, ''))), '');
  hom_nay date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  lo_id_moi bigint; trung bigint; r sx_hang_ve; truoc jsonb; sau jsonb; them boolean := false;
begin
  if pk is not null and coalesce(p_khong_nhap, false) then
    raise exception 'Chọn một: số phiếu Pancake hoặc "không nhập"';
  end if;
  if p_ngay is not null and p_ngay > hom_nay then raise exception 'Ngày hàng về % ở tương lai', p_ngay; end if;
  if ma <> '' or l <> '' then
    select id into lo_id_moi from sx_lo_cat where ma_hang = ma and lo = l;
    if lo_id_moi is null then
      raise exception 'Chưa có lô cắt % %. Ghi lô cắt trước (mk_sx_lot_save), hàng về phải ghi đúng theo lô', ma, l;
    end if;
  end if;

  if p_id is null then
    if lo_id_moi is null or p_ngay is null or p_lines is null then
      raise exception 'Lần hàng về mới cần mã hàng, lô, ngày và các dòng màu × size';
    end if;
    select id into trung from sx_hang_ve where lo_id = lo_id_moi and ngay = p_ngay and nguon = src limit 1;
    if trung is not null then
      raise exception 'Đã có lần hàng về #% cùng lô, ngày và nguồn. Muốn sửa thì truyền id', trung;
    end if;
    insert into sx_hang_ve (lo_id, ngay, so_phieu_xuong, nguoi_ky, so_phieu_pancake, khong_nhap_pancake, ghi_chu, nguon, nguoi_ghi)
    values (lo_id_moi, p_ngay, nullif(trim(p_so_phieu_xuong), ''), nullif(trim(p_nguoi_ky), ''), pk,
      coalesce(p_khong_nhap, false), p_ghi_chu, src, a)
    returning * into r;
    them := true;
  else
    select * into r from sx_hang_ve where id = p_id;
    if r.id is null then raise exception 'Không có lần hàng về #%', p_id; end if;
    truoc := to_jsonb(r) || jsonb_build_object('dong',
      (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_hang_ve_dong x where x.hang_ve_id = r.id));
    update sx_hang_ve set
      lo_id = coalesce(lo_id_moi, lo_id), ngay = coalesce(p_ngay, ngay),
      so_phieu_xuong = coalesce(nullif(trim(p_so_phieu_xuong), ''), so_phieu_xuong),
      nguoi_ky = coalesce(nullif(trim(p_nguoi_ky), ''), nguoi_ky),
      so_phieu_pancake = case when coalesce(p_khong_nhap, false) then null else coalesce(pk, so_phieu_pancake) end,
      khong_nhap_pancake = case when pk is not null then false else coalesce(p_khong_nhap, khong_nhap_pancake) end,
      ghi_chu = coalesce(p_ghi_chu, ghi_chu),
      nguon = src, nguoi_ghi = a, sua_luc = now()
    where id = r.id returning * into r;
  end if;

  if p_lines is not null then
    delete from sx_hang_ve_dong where hang_ve_id = r.id;
    insert into sx_hang_ve_dong (hang_ve_id, mau, size, xuong_giao, kho_dem)
    select r.id, x.mau, x.size, x.v1, x.v2 from public.sx_doc_dong(p_lines, array['xuong_giao', 'kho_dem']) x;
  end if;

  if r.so_phieu_pancake is not null then
    if exists (select 1 from sx_hang_ve_dong x where x.hang_ve_id = r.id and x.kho_dem is null) then
      raise exception 'Kho chưa đếm đủ các dòng: chưa được ghi số phiếu Pancake (kho thực nhận rồi mới nhập Pancake)';
    end if;
    if r.nguoi_ky is null then
      raise exception 'Thiếu người của kho ký nhận: chưa được ghi số phiếu Pancake';
    end if;
  end if;

  sau := to_jsonb(r) || jsonb_build_object('dong',
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sx_hang_ve_dong x where x.hang_ve_id = r.id));
  insert into sx_nhat_ky (bang, ban_ghi_id, hanh_dong, truoc, sau, nguon, nguoi_ghi)
  values ('sx_hang_ve', r.id, case when them then 'them' else 'sua' end, truoc, sau, src, a);
  perform public.sx_ghi_log(a, 'sx_arrival_save', 'ghi', '#' || r.id::text || ' ' || r.ngay::text);
  return jsonb_build_object('da_them_moi', them, 'hang_ve', sau,
    'xuong_giao', (select coalesce(sum(xuong_giao), 0) from sx_hang_ve_dong where hang_ve_id = r.id),
    'kho_dem', (select coalesce(sum(kho_dem), 0) from sx_hang_ve_dong where hang_ve_id = r.id),
    'lo', (select to_jsonb(t) from sx_tien_do_lo t where t.lo_id = r.lo_id));
end $$;

-- ============ ĐỌC ============

-- Tiến độ theo lô, kèm ma trận màu × size và lịch sử dời hẹn.
create or replace function public.mk_sx_progress(p_agent text, p_ma_hang text default null, p_chi_con_no boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.sx_ghi_log(p_agent, 'sx_progress', 'doc', coalesce(p_ma_hang, 'tat_ca'));
  return jsonb_build_object(
    'hom_nay', (now() at time zone 'Asia/Ho_Chi_Minh')::date,
    'cong_thuc', 'con_no = so_cat − kho_dem (số kho đếm, không phải số xưởng giao); cho_kho_dem = xưởng đã giao mà kho chưa đếm',
    'lo', coalesce((
      select jsonb_agg(to_jsonb(t) || jsonb_build_object(
        'dong', (select coalesce(jsonb_agg(jsonb_build_object('mau', d.mau, 'size', d.size, 'so_cat', d.so_cat,
            'xuong_giao', d.xuong_giao, 'kho_dem', d.kho_dem, 'con_no', d.con_no) order by d.mau, d.size), '[]')
          from sx_tien_do d where d.lo_id = t.lo_id),
        'doi_hen', (select coalesce(jsonb_agg(jsonb_build_object('hen_cu', h.hen_cu, 'hen_moi', h.hen_moi,
            'ly_do', h.ly_do, 'nguon', h.nguon, 'ghi_luc', h.ghi_luc) order by h.id), '[]')
          from sx_doi_hen h where h.lo_id = t.lo_id))
        order by t.ngay_tre desc, t.ma_hang, t.lo)
      from sx_tien_do_lo t
      where (p_ma_hang is null or t.ma_hang ilike trim(p_ma_hang) || '%')
        and (not coalesce(p_chi_con_no, false) or (t.trang_thai = 'dang_ve' and t.con_no > 0))), '[]'));
end $$;

-- Nhật ký hàng về (mới nhất trước), kèm dòng màu × size và id để sửa.
create or replace function public.mk_sx_arrivals(p_agent text, p_ma_hang text default null, p_from date default null,
  p_to date default null, p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.sx_ghi_log(p_agent, 'sx_arrivals', 'doc', coalesce(p_ma_hang, 'tat_ca'));
  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.ngay desc, t.id desc) from (
      select h.id, h.ngay, l.ma_hang, l.lo, h.so_phieu_xuong, h.nguoi_ky, h.so_phieu_pancake, h.khong_nhap_pancake,
        h.ghi_chu, h.nguon, h.nguoi_ghi, h.ghi_luc, h.sua_luc,
        (select coalesce(sum(x.xuong_giao), 0) from sx_hang_ve_dong x where x.hang_ve_id = h.id) as xuong_giao,
        (select coalesce(sum(x.kho_dem), 0) from sx_hang_ve_dong x where x.hang_ve_id = h.id) as kho_dem,
        (select coalesce(jsonb_agg(jsonb_build_object('mau', x.mau, 'size', x.size, 'xuong_giao', x.xuong_giao,
            'kho_dem', x.kho_dem) order by x.mau, x.size), '[]')
          from sx_hang_ve_dong x where x.hang_ve_id = h.id) as dong
      from sx_hang_ve h join sx_lo_cat l on l.id = h.lo_id
      where (p_ma_hang is null or l.ma_hang ilike trim(p_ma_hang) || '%')
        and (p_from is null or h.ngay >= p_from) and (p_to is null or h.ngay <= p_to)
      order by h.ngay desc, h.id desc
      limit greatest(1, least(coalesce(p_limit, 50), 500))) t), '[]');
end $$;

-- Phiếu đặt: số đặt, số đã cắt (các lô nối với phiếu), còn chờ cắt.
create or replace function public.mk_sx_orders(p_agent text, p_ma_hang text default null, p_trang_thai text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.sx_ghi_log(p_agent, 'sx_orders', 'doc', coalesce(p_ma_hang, 'tat_ca'));
  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.ngay_dat desc nulls last, t.id desc) from (
      select p.id, p.ma_hang, p.dot, p.ngay_dat, p.gia, p.ngay_du_kien_cat, p.trang_thai, p.ghi_chu, p.nguon,
        p.nguoi_ghi, p.ghi_luc, p.sua_luc, s.so_dat, c.da_cat, s.so_dat - c.da_cat as con_cho_cat,
        (select coalesce(jsonb_agg(jsonb_build_object('mau', x.mau, 'size', x.size, 'so_luong', x.so_luong)
            order by x.mau, x.size), '[]') from sx_phieu_dat_dong x where x.phieu_id = p.id) as dong
      from sx_phieu_dat p
      cross join lateral (select coalesce(sum(x.so_luong), 0)::int as so_dat from sx_phieu_dat_dong x where x.phieu_id = p.id) s
      cross join lateral (select coalesce(sum(d.so_cat), 0)::int as da_cat
        from sx_lo_cat l join sx_lo_cat_dong d on d.lo_id = l.id where l.phieu_dat_id = p.id) c
      where (p_ma_hang is null or p.ma_hang ilike trim(p_ma_hang) || '%')
        and (p_trang_thai is null or p.trang_thai = p_trang_thai)) t), '[]');
end $$;

-- Chỉ service role (máy chủ) được gọi.
do $$
declare f text;
begin
  foreach f in array array[
    'sx_ghi_log(text,text,text,text)', 'sx_can_nguon(text)', 'sx_doc_dong(jsonb,text[])',
    'mk_sx_order_save(text,text,text,text,jsonb,date,numeric,date,text,text)',
    'mk_sx_lot_save(text,text,text,text,jsonb,date,date,numeric,text,text,text)',
    'mk_sx_lot_reschedule(text,text,text,date,text,text)',
    'mk_sx_arrival_save(text,text,bigint,text,text,date,jsonb,text,text,text,boolean,text)',
    'mk_sx_progress(text,text,boolean)', 'mk_sx_arrivals(text,text,date,date,int)', 'mk_sx_orders(text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
