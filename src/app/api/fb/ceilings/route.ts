import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nhập % (20 hoặc 20,5) hoặc tỉ lệ (0,2) → tỉ lệ. */
function parsePercent(s: unknown): number | null {
  const n = Number(String(s ?? "").replace("%", "").replace(",", ".").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1 ? n / 100 : n;
}

/** Sửa bảng trần (fb_ceilings). Chỉ ghi Supabase, không đụng Meta. */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const back = (msg: string) => Response.redirect(`${origin}/fb/tran?msg=${encodeURIComponent(msg)}`, 303);
  const f = await request.formData();
  const code = String(f.get("product_code") ?? "").trim().toUpperCase();
  if (!/^(\*|[A-Z0-9]{3,20})$/.test(code)) return back("Mã không hợp lệ.");
  if (f.get("delete")) {
    if (code === "*") return back("Không xóa dòng mặc định.");
    const { error } = await db().from("fb_ceilings").delete().eq("product_code", code);
    return back(error ? `Lỗi: ${error.message}` : `Đã xóa trần ${code}.`);
  }
  const lai = parsePercent(f.get("profit_ceiling"));
  const hv = parsePercent(f.get("breakeven"));
  if (!lai || !hv || lai > hv) return back("Trần lãi và hòa vốn phải là số %, trần lãi ≤ hòa vốn.");
  const note = String(f.get("note") ?? "").trim().slice(0, 200) || null;
  const { error } = await db()
    .from("fb_ceilings")
    .upsert({ product_code: code, profit_ceiling: lai, breakeven: hv, note, updated_at: new Date().toISOString() });
  return back(error ? `Lỗi: ${error.message}` : `Đã lưu ${code}: trần lãi ${Math.round(lai * 1000) / 10}%, hòa vốn ${Math.round(hv * 1000) / 10}%.`);
}
