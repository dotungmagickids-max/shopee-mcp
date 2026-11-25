import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { parsePlanForm, taskOf } from "@/lib/facebook/content-plan";
import { loadPlanItem } from "@/lib/facebook/content-plan-data";
import { PAGES } from "@/lib/facebook/magic-data";
import { db } from "@/lib/supabase";
import { sameOrigin } from "@/lib/video/ui-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT = "web_lich_content";
const DEFAULT_ASSIGNEE = "Hường";

/**
 * Thêm, sửa, xóa dòng lịch content (bảng content_plan) và giao việc lên bảng việc chung. Chỉ anh (đăng nhập quản trị).
 * "Giao việc" tạo một việc cho người làm (báo qua Telegram trong ~10 phút): chỉ chạy khi anh bấm nút.
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  if (!sameOrigin(request)) return new Response("bad origin", { status: 403 });
  const origin = new URL(request.url).origin;
  const f = await request.formData();
  const raw = (k: string) => String(f.get(k) ?? "").trim();
  const q = new URLSearchParams();
  if (raw("tab") === "thieu") q.set("tab", "thieu");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw("tuan"))) q.set("tuan", raw("tuan"));
  const back = (msg: string) => {
    q.set("msg", msg.slice(0, 300));
    return Response.redirect(`${origin}/fb/content?${q.toString()}`, 303);
  };
  const short = (e: { message: string }) => e.message.slice(0, 160);
  const idOf = (k: string) => {
    const n = Number(raw(k));
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  try {
    if (raw("delete")) {
      const id = idOf("delete");
      if (!id) return back("Dòng lịch không hợp lệ.");
      const { error } = await db().from("content_plan").delete().eq("id", id);
      return back(error ? `Chưa xóa được: ${short(error)}` : "Đã xóa dòng lịch.");
    }

    if (raw("assign")) {
      const id = idOf("assign");
      const item = id ? await loadPlanItem(id) : null;
      if (!item) return back("Không tìm thấy dòng lịch.");
      if (item.task_id) return back(`Dòng này đã giao rồi (việc số ${item.task_id}).`);
      const nguoi = raw("nguoi") || item.nguoi || DEFAULT_ASSIGNEE;
      const t = taskOf(item, PAGES);
      const { data, error } = await db().rpc("mk_task_create", { p_agent: AGENT, p_assignee: nguoi, p_title: t.title, p_detail: t.detail, p_due: item.ngay, p_priority: 2, p_department: "content" });
      if (error) return back(`Chưa giao được việc: ${short(error)}`);
      const taskId = Number((data as { id?: number } | null)?.id) || null;
      const { error: e2 } = await db()
        .from("content_plan")
        .update({ task_id: taskId, nguoi, trang_thai: item.trang_thai === "de_xuat" ? "can_lam" : item.trang_thai, updated_at: new Date().toISOString() })
        .eq("id", item.id);
      return back(e2 ? `Đã giao việc số ${taskId} cho ${nguoi} nhưng chưa ghi lại vào lịch: ${short(e2)}` : `Đã giao việc số ${taskId} cho ${nguoi}; người làm được báo qua Telegram trong khoảng 10 phút.`);
    }

    const p = parsePlanForm(raw, PAGES);
    if (!p.ok) return back(p.error);
    const id = idOf("id");
    if (id) {
      const { error } = await db().from("content_plan").update({ ...p.row, updated_at: new Date().toISOString() }).eq("id", id);
      return back(error ? `Chưa lưu được: ${short(error)}` : "Đã lưu dòng lịch.");
    }
    const { error } = await db().from("content_plan").insert(p.row);
    return back(error ? `Chưa thêm được: ${short(error)}` : p.row.nguon === "de_xuat" ? `Đã đưa ${p.row.ma.join(", ")} vào lịch (trạng thái Đề xuất, chưa xếp ngày).` : "Đã thêm vào lịch.");
  } catch (e) {
    return back(`Lỗi: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
}
