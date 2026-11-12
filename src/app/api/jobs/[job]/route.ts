import { checkJobSecret } from "@/lib/autopilot/config";
import { backfillJob, capsJob, collectJob, dailyJob, morningReportJob, refreshJob, resetJob } from "@/lib/autopilot/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PARTS = ["ads", "orders", "escrow", "costs", "roas"] as const;

/**
 * Job do Supabase pg_cron gọi (xem supabase/cron.sql):
 *   POST /api/jobs/collect                              mỗi 15 phút (thu số liệu + luật trong ngày)
 *   POST /api/jobs/collect?fast=1                       mỗi 5 phút lúc 20h–1h59 (chỉ số giờ chiến dịch + luật)
 *   POST /api/jobs/reset                                00:00 (reset ngân sách, bật lại chiến dịch tool dừng)
 *   POST /api/jobs/daily?part=ads|orders|escrow|costs|roas  01:00 / 01:05 / 01:10 / 01:15 / 01:20
 *   POST /api/jobs/report                               08:00
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
    else if (job === "backfill" && /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date") ?? "")) result = await backfillJob(sp.get("date")!);
    else return Response.json({ error: "unknown job" }, { status: 404 });
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
