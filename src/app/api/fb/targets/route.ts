import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { parseMoney, parseRatio } from "@/lib/facebook/targets";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lưu mục tiêu quảng cáo (bảng fb_targets). Chỉ ghi Supabase, không đụng Meta. Ô để trống = bỏ mục tiêu đó. */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const back = (msg: string) => Response.redirect(`${origin}/fb/muc-tieu?msg=${encodeURIComponent(msg)}`, 303);
  const f = await request.formData();
  const raw = (k: string) => String(f.get(k) ?? "").trim();
  const money = (k: string) => (raw(k) ? parseMoney(raw(k)) : null);
  const month = money("month_budget");
  const day = money("day_budget");
  if (raw("month_budget") && month == null) return back("Mục tiêu tháng không đọc được. Ví dụ: 60tr hoặc 60000000.");
  if (raw("day_budget") && day == null) return back("Mục tiêu ngày không đọc được. Ví dụ: 2tr hoặc 2000000.");
  const ratio = parseRatio(raw("ratio") || "20");
  if (ratio == null) return back("Tỉ lệ quảng cáo/doanh thu phải từ 1% đến 100%.");
  const ad = parseMoney(raw("ad_budget") || "65000");
  if (ad == null || ad < 20_000 || ad > 5_000_000) return back("Ngân sách mỗi quảng cáo mới phải từ 20.000đ đến 5.000.000đ.");
  if (month != null && day != null && day > month) return back("Mục tiêu ngày đang lớn hơn mục tiêu tháng.");
  const { error } = await db()
    .from("fb_targets")
    .upsert({ id: 1, month_budget: month, day_budget: day, ratio, ad_budget: ad, updated_at: new Date().toISOString() });
  return back(error ? `Chưa lưu được: ${error.message.slice(0, 160)}` : "Đã lưu mục tiêu.");
}
