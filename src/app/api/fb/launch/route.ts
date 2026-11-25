import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { validate, WEB_CANNOT_CREATE, webCanCreate, type LaunchConfig, type LaunchItem } from "@/lib/facebook/launch";
import { runLaunch, saveRunResults, startRun } from "@/lib/facebook/launch-data";
import { PAGES } from "@/lib/facebook/magic-data";
import { listAccounts } from "@/lib/facebook/meta";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Tạo camp trên Meta, luôn ở trạng thái TẠM DỪNG. Chỉ chạy khi anh đã đăng nhập và bấm xác nhận
 * trên màn Lên camp (trường `confirmed`). Mọi lệnh được ghi vào fb_write_log.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return json({ error: "Chưa đăng nhập." }, 401);
  if (!sameOrigin(request)) return json({ error: "bad origin" }, 403);
  const body: any = await request.json().catch(() => null);
  if (body?.confirmed !== true) return json({ error: "Thiếu xác nhận." }, 400);
  const c = body?.config ?? {};
  const cfg: LaunchConfig = {
    page_id: String(c.page_id ?? ""),
    accounts: Array.isArray(c.accounts) ? c.accounts.map(String) : [],
    budget: Math.round(Number(c.budget)),
    structure: c.structure === "cbo" ? "cbo" : "abo",
    age_min: Math.round(Number(c.age_min)),
    age_max: Math.round(Number(c.age_max)),
    gender: c.gender === "female" || c.gender === "male" ? c.gender : "all",
    placement: c.placement === "facebook" ? "facebook" : "auto",
    cbo_name: typeof c.cbo_name === "string" ? c.cbo_name.slice(0, 200) : undefined,
    shape: c.shape === "1-n-1" || c.shape === "1-1-n" || c.shape === "n-1-1" ? c.shape : undefined,
    adset_name: typeof c.adset_name === "string" ? c.adset_name.slice(0, 180) : undefined,
    start_time: typeof c.start_time === "string" && c.start_time ? c.start_time.slice(0, 16) : undefined,
  };
  const items: LaunchItem[] = Array.isArray(body?.items)
    ? body.items.map((i: any) => ({ post_id: String(i?.post_id ?? ""), name: String(i?.name ?? "") }))
    : [];
  const bad = validate(cfg, items);
  if (bad) return json({ error: bad }, 400);
  if (!PAGES[cfg.page_id]) return json({ error: "Page không thuộc Magickids." }, 400);
  // Chặn trước khi gọi Meta: tạo sẽ lỗi quyền ở bước nhóm và để lại chiến dịch rỗng.
  if (!webCanCreate(cfg.page_id)) {
    return json({ error: `Web không tạo được quảng cáo cho page ${WEB_CANNOT_CREATE[cfg.page_id]} (page không thuộc doanh nghiệp của web). Anh bấm Lưu nháp rồi nhắn em để lên theo quy trình chuẩn.` }, 400);
  }
  // Chỉ tài khoản đang theo dõi (đã bỏ BOSS TUYỀN 3/4/5/6).
  const allowed = new Set((await listAccounts()).map((a) => a.id));
  if (cfg.accounts.some((a) => !allowed.has(a))) return json({ error: "Có tài khoản quảng cáo không được phép dùng." }, 400);
  // Lưu lần lên camp trước khi gọi Meta, cập nhật sau mỗi quảng cáo: tải lại trang hay mất kết nối vẫn xem lại được.
  const runId = await startRun(cfg, items).catch(() => null);
  try {
    const results = await runLaunch(cfg, items, runId ? (r) => saveRunResults(runId, r, false) : undefined);
    if (runId) await saveRunResults(runId, results, true).catch(() => undefined);
    return json({ results, run_id: runId });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), run_id: runId }, 500);
  }
}
