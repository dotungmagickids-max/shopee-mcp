/**
 * "Sai vì…": anh bấm Bỏ qua một đề xuất → nhân viên hỏi lý do; anh trả lời tin hỏi bằng một câu →
 * lưu vào employee_feedback làm bài học (rà hằng tuần để chỉnh luật). Dùng chung cho mọi nhân viên.
 */
import { esc } from "./autopilot/telegram";
import { db } from "./supabase";

export type Bot = "facebook" | "shopee";
export type Sender = (text: string, replyMarkup?: unknown) => Promise<number | null>;

/** Câu hỏi gửi sau khi anh bỏ qua (hàm thuần để test). */
export function whyQuestion(summary: string): string {
  return `❓ Anh vừa bỏ qua: <i>${esc(summary.slice(0, 300))}</i>\nĐề xuất này sai ở đâu? Anh <b>trả lời tin này</b> một câu (ví dụ "mã đang chờ hàng, không tắt"), em ghi lại để lần sau không đề xuất sai nữa.`;
}

/** Hỏi lý do. Không chặn luồng chính nếu lỗi. */
export async function askWhy(bot: Bot, refKind: string, refId: number, summary: string, send: Sender): Promise<void> {
  try {
    const msgId = await send(whyQuestion(summary), { force_reply: true, selective: true, input_field_placeholder: "Sai vì…" });
    if (!msgId) return;
    await db().from("employee_feedback").insert({ bot, ref_kind: refKind, ref_id: refId, proposal: summary.slice(0, 1000), ask_message_id: msgId });
  } catch {
    /* không làm hỏng nút bấm */
  }
}

/**
 * Tin anh trả lời một câu hỏi "Sai vì…" của đúng bot này → lưu lý do. Trả về true nếu đã xử lý.
 * Mọi bot trong nhóm đều nhận tin; chỉ bot đã hỏi (khớp message_id + bot) mới ghi.
 */
export async function captureWhy(bot: Bot, msg: any, send: Sender): Promise<boolean> {
  const replyTo = Number(msg?.reply_to_message?.message_id ?? 0);
  const text = String(msg?.text ?? "").trim();
  if (!replyTo || !text || text.startsWith("/")) return false;
  const { data: row } = await db()
    .from("employee_feedback")
    .select("id, proposal, reason")
    .eq("bot", bot)
    .eq("ask_message_id", replyTo)
    .maybeSingle();
  if (!row) return false;
  await db()
    .from("employee_feedback")
    .update({ reason: text.slice(0, 2000), answered_at: new Date().toISOString() })
    .eq("id", row.id);
  await send(`📝 Em ghi rồi: <i>${esc(text.slice(0, 300))}</i>\nCuối tuần em gom các lý do này để đề xuất chỉnh luật cho anh duyệt.`);
  return true;
}

/** Dòng tổng kết tuần: các lý do anh bỏ qua đề xuất của bot này trong 7 ngày (rỗng nếu không có). */
export async function weeklyWhyLines(bot: Bot): Promise<string[]> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data } = await db()
    .from("employee_feedback")
    .select("proposal, reason")
    .eq("bot", bot)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = data ?? [];
  if (!rows.length) return [];
  const answered = rows.filter((r: any) => r.reason);
  return [
    `🧭 <b>Tuần qua anh bỏ qua ${rows.length} đề xuất</b> (${answered.length} có lý do):`,
    ...answered.slice(0, 8).map((r: any) => `• ${esc(String(r.proposal).slice(0, 80))} → <i>${esc(String(r.reason).slice(0, 120))}</i>`),
    "Em sẽ đề xuất chỉnh luật theo các lý do này để anh duyệt.",
  ];
}
