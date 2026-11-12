import { checkJobSecret } from "@/lib/autopilot/config";
import { fbReportJob, fbSetupJob, fbWatchJob } from "@/lib/facebook/jobs";
import { careJob, careWeeklyJob } from "@/lib/autopilot/care";
import { tasksJob } from "@/lib/tasks";
import { backfillJob, capsJob, collectJob, dailyJob, launchJob, lifecycleJob, morningReportJob, refreshJob, resetJob } from "@/lib/autopilot/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PARTS = ["ads", "orders", "escrow", "costs", "roas", "steps"] as const;

/**
 * Job do Supabase pg_cron gọi (xem supabase/cron.sql):
 *   POST /api/jobs/collect                              mỗi 15 phút (thu số liệu + luật trong ngày)
 *   POST /api/jobs/collect?fast=1                       mỗi 5 phút cả ngày, 2 phút lúc 0h (chỉ số giờ chiến dịch + luật)
 *   POST /api/jobs/reset                                00:00 (reset ngân sách, bật lại chiến dịch tool dừng)
 *   POST /api/jobs/daily?part=ads|orders|escrow|costs|roas  01:00 / 01:05 / 01:10 / 01:15 / 01:20
 *   POST /api/jobs/daily?part=steps                     01:30 (thử bậc lãi: cải tiến liên tục)
 *   POST /api/jobs/report                               08:00
 *   POST /api/jobs/lifecycle                            thứ Hai 06:40 (vòng đời sản phẩm, trang /admin/lifecycle)
 *   POST /api/jobs/launch                              thứ Hai 07:10 (đề xuất lên QC mã chưa chạy + đánh giá hàng Mới)
 *   POST /api/jobs/fb-report                            08:00 (Nhân viên Facebook: báo sáng + đề xuất tăng)
 *   POST /api/jobs/fb-setup                             chạy 1 lần: nối webhook + lệnh cho bot Kiều Trang
 *   POST /api/jobs/fb-watch                             mỗi giờ 9h–23h (Nhân viên Facebook: cảnh báo trong ngày)
 *   POST /api/jobs/tasks[?morning=1]                    10 phút: báo việc mới (bảng việc chung); 8h: việc từng người
 *   POST /api/jobs/care                                 mỗi giờ 8h–22h (đơn trễ, đánh giá; 20h cảm ơn hàng loạt; 9h sức khỏe shop)
 *   POST /api/jobs/care-weekly                          thứ Hai 08:15 (báo cáo tuần chăm shop)
 *   POST /api/jobs/backfill?date=YYYY-MM-DD             chạy tay để nạp bù lịch sử
 * Header bắt buộc: Authorization: Bearer <JOB_SECRET>
 */
export async function POST(request: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!checkJobSecret(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await ctx.params;
  const sp = new URL(request.url).searchParams;
  const part = sp.get("part") as (typeof PARTS)[number] | null;
  try {
    let result: unknown;
    if (job === "collect") result = await collectJob(sp.get("fast") === "1");
    else if (job === "reset") result = await resetJob();
    else if (job === "daily" && part && PARTS.includes(part)) result = await dailyJob(part);
    else if (job === "report") result = await morningReportJob();
    else if (job === "caps") result = await capsJob();
    else if (job === "refresh") result = await refreshJob();
    else if (job === "launch") result = await launchJob();
    else if (job === "fb-report") result = await fbReportJob(/^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "") ? sp.get("date")! : undefined);
    else if (job === "fb-watch") result = await fbWatchJob();
    else if (job === "fb-setup") result = await fbSetupJob();
    else if (job === "tasks") result = await tasksJob(sp.get("morning") === "1");
    else if (job === "care") result = await careJob();
    else if (job === "care-weekly") result = await careWeeklyJob();
    else if (job === "lifecycle") result = await lifecycleJob();
    else if (job === "backfill" && /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "")) result = await backfillJob(sp.get("date")!);
    else return Response.json({ error: "unknown job" }, { status: 404 });
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
