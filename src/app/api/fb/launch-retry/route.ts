import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { createAdInAdset, loadRun, saveLogRun, saveRunResults } from "@/lib/facebook/launch-data";
import { canRetry } from "@/lib/facebook/launch-history";
import { PAGES } from "@/lib/facebook/magic-data";
import { listAccounts } from "@/lib/facebook/meta";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Tạo lại MỘT quảng cáo lỗi của một lần lên camp, vào đúng nhóm đã tạo (quảng cáo ở trạng thái tạm dừng).
 * Lần lên camp dựng từ nhật ký (`log` = "từId-đếnId") được lưu thành lần đã lưu trước, rồi mới tạo lại.
 * Chỉ chạy khi anh bấm "Tạo lại" và xác nhận. Mọi lệnh ghi vào fb_write_log.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return json({ error: "Chưa đăng nhập." }, 401);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  const body: any = await request.json().catch(() => null);
  if (body?.confirmed !== true) return json({ error: "Thiếu xác nhận." }, 400);
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 0) return json({ error: "Dòng không hợp lệ." }, 400);
  try {
    let run;
    if (body?.run_id != null) {
      run = await loadRun(Number(body.run_id));
    } else {
      const m = /^(\d+)-(\d+)$/.exec(String(body?.log ?? ""));
      if (!m) return json({ error: "Thiếu lần lên camp." }, 400);
      run = await saveLogRun(Number(m[1]), Number(m[2]));
    }
    if (!run) return json({ error: "Không tìm thấy lần lên camp." }, 404);
    const r = run.results[index];
    if (!r) return json({ error: "Không tìm thấy quảng cáo này trong lần lên camp." }, 404);
    if (r.ad_id) return json({ error: `Quảng cáo này đã tạo rồi (QC ${r.ad_id}).`, run_id: run.id }, 409);
    if (!canRetry(r)) return json({ error: "Dòng này chưa có nhóm quảng cáo hoặc không rõ bài: không tạo lại từ đây được, anh lên theo quy trình chuẩn.", run_id: run.id }, 400);
    if (!PAGES[r.post_id.split("_")[0]]) return json({ error: "Bài không thuộc page Magickids." }, 400);
    const allowed = new Set((await listAccounts()).map((a) => a.id));
    if (!allowed.has(r.account_id)) return json({ error: "Tài khoản quảng cáo không được phép dùng." }, 400);
    await createAdInAdset(r);
    const results = [...run.results];
    results[index] = r;
    await saveRunResults(run.id, results, false);
    return json({ result: r, run_id: run.id });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
