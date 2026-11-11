import { checkJobSecret } from "@/lib/autopilot/config";
import { collectJob, dailyJob, morningReportJob } from "@/lib/autopilot/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Job do Supabase pg_cron gọi (xem supabase/cron.sql):
 *   POST /api/jobs/collect                 mỗi 15 phút
 *   POST /api/jobs/daily?part=ads|orders|escrow   01:00 / 01:05 / 01:10
 *   POST /api/jobs/report                  08:00
 * Header bắt buộc: Authorization: Bearer <JOB_SECRET>
 */
export async function POST(request: Request, ctx: { params: Promise<{ job: string }> }) {
  if (!checkJobSecret(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await ctx.params;
  const part = new URL(request.url).searchParams.get("part");
  try {
    let result: unknown;
    if (job === "collect") result = await collectJob();
    else if (job === "daily" && (part === "ads" || part === "orders" || part === "escrow")) result = await dailyJob(part);
    else if (job === "report") result = await morningReportJob();
    else return Response.json({ error: "unknown job" }, { status: 404 });
    return Response.json({ ok: true, result });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
