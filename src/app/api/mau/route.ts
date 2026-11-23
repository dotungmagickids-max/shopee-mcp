import { CHUAN_BI, danhDauChuanBi, docLenhMau, hoSoTheoVai, loiChuyen, tomTatSua, vaiCuaKhoa, type HoSoRow, type Vai } from "@/lib/mau";
import { dongTuSo, gomMaBan, maBanTheoVai, namTuMa, type BienTheRow, type LaiRow, type MaBanRow } from "@/lib/mau-ban";
import { allRows, db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Trang /mau nằm cùng máy chủ nên không mở CORS.
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const CHUA_BAT = "Máy chủ chưa bật phần Mẫu và media";
const LOI_CHUNG = "Máy chủ chưa xử lý được, thử lại sau ít phút";

function vaiHoacTuChoi(request: Request): Vai | Response {
  const vai = vaiCuaKhoa(request);
  if (vai === "unset") return json({ error: "Chưa đặt mã truy cập cho trang Mẫu và media" }, 503);
  if (vai === "bad") return json({ error: "Mã truy cập không đúng" }, 401);
  return vai;
}

type LoiDb = { code?: string | null; message?: string | null };

/** Bảng của migration 0029 chưa có → 501 với câu rõ ràng; lỗi khác → 502, không lộ chi tiết kỹ thuật. */
function traLoi(viec: string, err: LoiDb | unknown): Response {
  const e = (err ?? {}) as LoiDb;
  const m = e.message ?? (err instanceof Error ? err.message : "");
  if (e.code === "42P01" || e.code === "PGRST205" || /schema cache|relation .* does not exist/i.test(m)) return json({ error: CHUA_BAT, chuaBat: true }, 501);
  console.error(`[mau] ${viec} lỗi:`, m);
  return json({ error: LOI_CHUNG }, 502);
}

const idTu = (v: string | null) => (v && /^\d{1,12}$/.test(v) ? Number(v) : null);

async function docHoSo(id: number): Promise<HoSoRow | null> {
  const { data, error } = await db().from("mau_ho_so").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as HoSoRow | null) ?? null;
}

async function coAnh(id: number): Promise<boolean> {
  const { data, error } = await db().from("mau_anh").select("ho_so_id").eq("ho_so_id", id).maybeSingle();
  if (error) throw error;
  return !!data;
}

async function ghiNhatKy(hoSoId: number, nguoi: string, vai: Vai, viec: string, tu = "", den = "", ghiChu = ""): Promise<void> {
  const { error } = await db().from("mau_nhat_ky").insert({ ho_so_id: hoSoId, nguoi, vai, viec, tu, den, ghi_chu: ghiChu });
  // Việc chính đã ghi xong; thiếu một dòng nhật ký thì báo log máy chủ, không báo lỗi cho người dùng.
  if (error) console.error("[mau] ghi nhật ký lỗi:", error.message);
}

const homNayVN = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Biến thể Pancake đã có sẵn trong database (không gọi Pancake), của một mã hoặc của mọi mã. */
function docBienThe(ma?: string): Promise<BienTheRow[]> {
  return allRows<BienTheRow>(() => {
    const q = db().from("pancake_variations").select("product_code, product_name, categories, stock, selling_avg, retail_price, image_url");
    return (ma ? q.eq("product_code", ma) : q).order("sku");
  });
}

/** Số cái đã bán trong năm (đã trừ hủy, hoàn) theo mã, từ hàm database mk_product_profit. */
async function docSoBan(nam: number, ma?: string): Promise<LaiRow[]> {
  const homNay = homNayVN();
  const { data, error } = await db().rpc("mk_product_profit", {
    p_agent: "web_mau",
    p_from: `${nam}-01-01`,
    p_to: String(nam) === homNay.slice(0, 4) ? homNay : `${nam}-12-31`,
    p_code: ma ?? null,
    p_limit: 500,
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as LaiRow[]) : [];
}

/** Tab "Mã bán tốt": đọc danh sách tự quản. Không gọi Pancake, không tự cập nhật. */
async function docMaBan(vai: Vai) {
  const cot = "ma, ten, gioi, loai, mua, nam, anh_url, sl_ban, nam_ban, so_ban_luc, nguon, an, ly_do_an";
  const docBang = (them: string) => allRows<MaBanRow>(() => db().from("mau_ma_ban").select(cot + them).order("ma"));
  const [rows, anh] = await Promise.all([
    // Database chưa có cột nhóm (migration 0034) thì vẫn trả danh sách, không có nhóm.
    docBang(", nhom").catch((err) => {
      if (!/nhom/.test(err instanceof Error ? err.message : "")) throw err;
      return docBang("");
    }),
    allRows<{ ma: string; cap_nhat_luc: string }>(() => db().from("mau_ma_anh").select("ma, cap_nhat_luc").order("ma")),
  ]);
  return { at: Date.now(), vai, namNay: Number(homNayVN().slice(0, 4)), ds: maBanTheoVai(rows, new Map(anh.map((a) => [a.ma, a.cap_nhat_luc])), vai) };
}

/**
 * Mẫu và media cho trang /mau. Header bắt buộc: x-mk-key (một trong ba mã: quản lý, người làm, người xem).
 *   GET /api/mau              → { at, vai, ds[] } hồ sơ theo vai (người xem chỉ thấy mẫu đã có media, không có giá nhập)
 *   GET /api/mau?anh=<id>     → ảnh đại diện của hồ sơ
 *   GET /api/mau?nhatky=<id>  → { ds[] } nhật ký của hồ sơ (không cho vai xem)
 *   GET /api/mau?anhma=<mã>   → ảnh tự đăng của một mã đang bán
 *   GET /api/mau?ban=1        → { ds[] } danh sách mã bán tốt tự quản (mã đang ẩn chỉ vai quản lý nhận)
 */
export async function GET(request: Request) {
  const vai = vaiHoacTuChoi(request);
  if (vai instanceof Response) return vai;
  const q = new URL(request.url).searchParams;
  try {
    if (q.has("anh")) {
      const id = idTu(q.get("anh"));
      if (id == null) return json({ error: "id không hợp lệ" }, 400);
      if (vai === "xem" && (await docHoSo(id))?.trang_thai !== "co_media") return json({ error: "Không có ảnh" }, 404);
      const { data, error } = await db().from("mau_anh").select("kieu, du_lieu").eq("ho_so_id", id).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Không có ảnh" }, 404);
      return new Response(new Uint8Array(Buffer.from(data.du_lieu as string, "base64")), {
        headers: { "Content-Type": data.kieu as string, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (q.has("anhma")) {
      const ma = (q.get("anhma") ?? "").toUpperCase();
      if (!/^[A-Z]{1,4}\d{5}$/.test(ma)) return json({ error: "Mã hàng không hợp lệ" }, 400);
      const { data, error } = await db().from("mau_ma_anh").select("kieu, du_lieu").eq("ma", ma).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "Không có ảnh" }, 404);
      return new Response(new Uint8Array(Buffer.from(data.du_lieu as string, "base64")), {
        headers: { "Content-Type": data.kieu as string, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (q.has("ban")) return json(await docMaBan(vai));
    if (q.has("nhatky")) {
      if (vai === "xem") return json({ error: "Mã truy cập này chỉ được xem" }, 403);
      const id = idTu(q.get("nhatky"));
      if (id == null) return json({ error: "id không hợp lệ" }, 400);
      const { data, error } = await db().from("mau_nhat_ky").select("luc, nguoi, vai, viec, tu, den, ghi_chu").eq("ho_so_id", id).order("luc", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ ds: data ?? [] });
    }
    const [rows, anh] = await Promise.all([
      allRows<HoSoRow>(() => db().from("mau_ho_so").select("*").order("cap_nhat_luc", { ascending: false }).order("id")),
      allRows<{ ho_so_id: number; cap_nhat_luc: string }>(() => db().from("mau_anh").select("ho_so_id, cap_nhat_luc").order("ho_so_id")),
    ]);
    return json({ at: Date.now(), vai, ds: hoSoTheoVai(rows, new Map(anh.map((a) => [a.ho_so_id, a.cap_nhat_luc])), vai) });
  } catch (err) {
    return traLoi("đọc", err);
  }
}

/**
 * Ghi hồ sơ mẫu. Header bắt buộc: x-mk-key. Thân JSON: xem `docLenhMau`.
 * Chỉ ghi vào các bảng `mau_*`; không gọi Shopee, Meta, Pancake hay kho lưu trữ ảnh.
 */
export async function POST(request: Request) {
  const vai = vaiHoacTuChoi(request);
  if (vai instanceof Response) return vai;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Thân yêu cầu không phải JSON" }, 400);
  }
  const lenh = docLenhMau(body, vai);
  if (!lenh.ok) return json({ error: lenh.error }, lenh.status ?? 400);
  const luc = new Date().toISOString();
  try {
    if (lenh.viec === "tao") {
      const { data, error } = await db().from("mau_ho_so").insert({ ...lenh.cot, ma: lenh.ma, nguoi_tao: lenh.nguoi }).select("id").single();
      if (error?.code === "23505") return json({ error: `Mã mẫu ${lenh.ma} đã có hồ sơ` }, 400);
      if (error) throw error;
      await ghiNhatKy(data.id as number, lenh.nguoi, vai, "tao", "", "dang_xem");
      return json({ ok: true, id: data.id });
    }

    if (lenh.viec === "ma_ban_them") {
      const nam = Number(homNayVN().slice(0, 4));
      const [bt, ban] = await Promise.all([docBienThe(lenh.ma), docSoBan(nam, lenh.ma).catch(() => [] as LaiRow[])]);
      const m = gomMaBan(bt, ban.filter((l) => String(l.ma).toUpperCase() === lenh.ma), true)[0];
      const dong = m ? dongTuSo(m, nam, lenh.nguoi, luc) : { ma: lenh.ma, nam: namTuMa(lenh.ma), nguon: "tay", nguoi: lenh.nguoi, cap_nhat_luc: luc };
      const { error } = await db().from("mau_ma_ban").insert(dong);
      if (error?.code === "23505") return json({ error: `Mã ${lenh.ma} đã có trong danh sách (có thể đang ẩn)` }, 400);
      if (error) throw error;
      return json({ ok: true, coSo: !!m });
    }
    if (lenh.viec === "ma_ban_sua") {
      const { data, error } = await db().from("mau_ma_ban").update({ ...lenh.cot, nguoi: lenh.nguoi, cap_nhat_luc: luc }).eq("ma", lenh.ma).select("ma");
      if (error) throw error;
      if (!data?.length) return json({ error: "Không có mã này trong danh sách" }, 404);
      return json({ ok: true });
    }
    if (lenh.viec === "ma_ban_nap") {
      const nam = Number(homNayVN().slice(0, 4));
      const ban = await docSoBan(nam);
      if (lenh.kieu === "dau") {
        // Nạp lần đầu: mọi mã có bán trong năm. Mã đã có trong bảng (kể cả mã đang ẩn) giữ nguyên.
        const ds = gomMaBan(await docBienThe(), ban).filter((m) => m.slBan > 0).map((m) => dongTuSo(m, nam, lenh.nguoi, luc));
        if (ds.length) {
          const { error } = await db().from("mau_ma_ban").upsert(ds, { onConflict: "ma", ignoreDuplicates: true });
          if (error) throw error;
        }
        return json({ ok: true, so: ds.length });
      }
      // Cập nhật số bán: chỉ các mã đang có trong danh sách, không thêm mã mới, không đổi tên, ảnh, phân loại.
      const co = await allRows<{ ma: string }>(() => db().from("mau_ma_ban").select("ma").order("ma"));
      const soBan = new Map(ban.map((l) => [String(l.ma).toUpperCase(), Math.max(0, Math.round(Number(l.sl_ban) || 0))]));
      const ds = co.map((r) => ({ ma: r.ma, sl_ban: soBan.get(r.ma) ?? 0, nam_ban: nam, so_ban_luc: luc }));
      if (ds.length) {
        const { error } = await db().from("mau_ma_ban").upsert(ds, { onConflict: "ma" });
        if (error) throw error;
      }
      return json({ ok: true, so: ds.length });
    }
    if (lenh.viec === "an_ma") {
      const { error } = await db().from("mau_ma_ban").upsert({ ma: lenh.ma, an: lenh.an, ly_do_an: lenh.an ? lenh.lyDo : "", nguoi: lenh.nguoi, cap_nhat_luc: luc }, { onConflict: "ma" });
      if (error) throw error;
      return json({ ok: true });
    }
    if (lenh.viec === "anh_ma") {
      const { error } = await db().from("mau_ma_anh").upsert({ ma: lenh.ma, kieu: lenh.kieu, du_lieu: lenh.duLieu, nguoi: lenh.nguoi, cap_nhat_luc: luc });
      if (error) throw error;
      return json({ ok: true, anh: luc });
    }

    const cu = await docHoSo(lenh.id);
    if (!cu) return json({ error: "Không có hồ sơ mẫu này" }, 404);

    if (lenh.viec === "sua") {
      const doi = tomTatSua(cu, lenh.cot);
      if (!doi) return json({ ok: true, khongDoi: true });
      const { error } = await db().from("mau_ho_so").update({ ...lenh.cot, cap_nhat_luc: luc }).eq("id", lenh.id);
      if (error) throw error;
      await ghiNhatKy(lenh.id, lenh.nguoi, vai, "sua", "", "", doi);
      return json({ ok: true });
    }

    if (lenh.viec === "lich" || lenh.viec === "chuan_bi") {
      if (cu.ngay_test === undefined) return json({ error: "Máy chủ chưa bật phần Lịch test", chuaBat: true }, 501);
      if (lenh.viec === "lich") {
        if ((cu.ngay_test ?? null) === lenh.ngay) return json({ ok: true, khongDoi: true });
        const { error } = await db().from("mau_ho_so").update({ ngay_test: lenh.ngay, cap_nhat_luc: luc }).eq("id", lenh.id);
        if (error) throw error;
        await ghiNhatKy(lenh.id, lenh.nguoi, vai, "lich", cu.ngay_test ?? "", lenh.ngay ?? "");
        return json({ ok: true });
      }
      const { error } = await db().from("mau_ho_so").update({ chuan_bi: danhDauChuanBi(cu.chuan_bi, lenh.muc, lenh.xong, lenh.nguoi, luc), cap_nhat_luc: luc }).eq("id", lenh.id);
      if (error) throw error;
      await ghiNhatKy(lenh.id, lenh.nguoi, vai, "chuan_bi", "", lenh.xong ? "xong" : "chua", CHUAN_BI.find((m) => m.k === lenh.muc)?.ten ?? lenh.muc);
      return json({ ok: true });
    }

    if (lenh.viec === "trang_thai") {
      const loi = loiChuyen(cu, lenh.den, lenh.ghiChu, await coAnh(lenh.id));
      if (loi) return json({ error: loi }, 400);
      const { error } = await db()
        .from("mau_ho_so")
        .update({ trang_thai: lenh.den, ly_do_bo: lenh.den === "bo" ? lenh.ghiChu : "", cap_nhat_luc: luc })
        .eq("id", lenh.id)
        .eq("trang_thai", cu.trang_thai);
      if (error) throw error;
      await ghiNhatKy(lenh.id, lenh.nguoi, vai, "trang_thai", cu.trang_thai, lenh.den, lenh.ghiChu);
      return json({ ok: true });
    }

    const { error } = await db().from("mau_anh").upsert({ ho_so_id: lenh.id, kieu: lenh.kieu, du_lieu: lenh.duLieu, cap_nhat_luc: luc });
    if (error) throw error;
    const cham = await db().from("mau_ho_so").update({ cap_nhat_luc: luc }).eq("id", lenh.id);
    if (cham.error) throw cham.error;
    await ghiNhatKy(lenh.id, lenh.nguoi, vai, "anh");
    return json({ ok: true, anh: luc });
  } catch (err) {
    return traLoi(lenh.viec, err);
  }
}
