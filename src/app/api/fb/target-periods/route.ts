import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { parseMoney, parseRatio } from "@/lib/facebook/targets";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Thêm, sửa, xóa mục tiêu theo khoảng ngày (bảng fb_target_periods). Chỉ ghi Supabase, không đụng Meta.
 * Ô "chi thật mỗi ngày" ghi 0 nghĩa là khoảng đó nghỉ, không chạy.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const f = await request.formData();
  const raw = (k: string) => String(f.get(k) ?? "").trim();
  const view = isDay(raw("ngay")) ? `&ngay=${raw("ngay")}` : "";
  const back = (msg: string) => Response.redirect(`${origin}/fb/muc-tieu?msg=${encodeURIComponent(msg)}${view}`, 303);

  if (raw("delete")) {
    const id = Number(raw("delete"));
    if (!Number.isInteger(id) || id <= 0) return back("Mã mục tiêu không hợp lệ.");
    const { error } = await db().from("fb_target_periods").delete().eq("id", id);
    return back(error ? `Chưa xóa được: ${error.message.slice(0, 160)}` : "Đã xóa mục tiêu khoảng ngày.");
  }

  const tu = raw("tu");
  const den = raw("den") || tu;
  if (!isDay(tu) || !isDay(den)) return back("Chọn ngày bắt đầu và ngày kết thúc.");
  if (tu > den) return back("Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.");
  if ((Date.parse(den) - Date.parse(tu)) / 86_400_000 > 366) return back("Một khoảng tối đa 1 năm.");
  const zero = /^0+(đ|d)?$/i.test(raw("day_budget"));
  const day = zero ? 0 : parseMoney(raw("day_budget"));
  if (day == null) return back("Chi thật mỗi ngày không đọc được. Ví dụ: 2tr, 1500000, hoặc 0 nếu nghỉ.");
  const ratio = raw("ratio") ? parseRatio(raw("ratio")) : null;
  if (raw("ratio") && ratio == null) return back("Tỉ lệ quảng cáo/doanh thu phải từ 1% đến 100%, hoặc để trống.");
  const row = { tu, den, day_budget: day, ratio, note: raw("note").slice(0, 200) || null, updated_at: new Date().toISOString() };
  const id = Number(raw("id"));
  const q = Number.isInteger(id) && id > 0 ? db().from("fb_target_periods").update(row).eq("id", id) : db().from("fb_target_periods").insert(row);
  const { error } = await q;
  if (error) return back(`Chưa lưu được: ${error.message.slice(0, 160)}`);
  return back(id > 0 ? "Đã sửa mục tiêu khoảng ngày." : "Đã thêm mục tiêu khoảng ngày.");
}
