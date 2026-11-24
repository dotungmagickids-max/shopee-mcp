import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { vnDate } from "@/lib/autopilot/time";
import { collectDay } from "@/lib/facebook/jobs";
import { scrub } from "@/lib/facebook/meta";
import { missingSpendDays } from "@/lib/facebook/targets";
import { loadMonthDays } from "@/lib/facebook/targets-data";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Mỗi lần bấm thu tối đa ngần này ngày, để không quá thời gian chạy của máy chủ. */
const PER_RUN = 4;

/**
 * Thu lại số quảng cáo của các ngày còn thiếu trong tháng (đọc Meta và Pancake, ghi bảng fb_ad_daily của mình).
 * Không có lệnh ghi lên Meta. Chỉ chạy khi anh bấm nút ở màn Mục tiêu.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const back = (msg: string) => Response.redirect(`${origin}/fb/muc-tieu?msg=${encodeURIComponent(msg)}`, 303);
  const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
  try {
    const today = vnDate();
    const missing = missingSpendDays(today, await loadMonthDays(today));
    if (!missing.length) return back("Tháng này không còn ngày nào thiếu số.");
    const todo = missing.slice(0, PER_RUN);
    const done: string[] = [];
    const notes: string[] = [];
    for (const day of todo) {
      const r = await collectDay(day);
      done.push(`${dm(day)} (${r.rows.length} quảng cáo)`);
      if (r.errors.length) notes.push(`${dm(day)}: ${scrub(r.errors.join("; ")).slice(0, 120)}`);
    }
    const left = missing.length - todo.length;
    return back(`Đã thu ${done.join(", ")}.${left ? ` Còn ${left} ngày, anh bấm thu tiếp.` : ""}${notes.length ? ` Có lỗi: ${notes.join(" | ")}` : ""}`.slice(0, 900));
  } catch (e) {
    return back(`Chưa thu được: ${scrub(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
}
