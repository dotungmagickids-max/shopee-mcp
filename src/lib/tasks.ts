/**
 * Bảng việc chung (Giao ban AI bước 1): nhân viên AI và người thật (Hiền, Vân, Hường, anh) giao/nhận việc.
 * Việc ghi vào core.team_tasks qua công cụ MCP mk_task_*. File này lo phần Telegram:
 *  - job "tasks" (10 phút): báo việc mới vào chủ đề Việc chung, gắn tên người làm, nút Xong / Đang làm / Không làm được;
 *  - job "tasks?morning=1" (8h): mỗi người một danh sách "việc của bạn hôm nay";
 *  - webhook: bấm nút, trả lời tin việc để ghi chú, lệnh /id và /viec.
 * Người thật bấm nút / trả lời = cập nhật trạng thái việc của chính họ, KHÔNG phải lệnh ghi lên hệ thống.
 *
 * Biến môi trường:
 *  - TELEGRAM_STAFF: "Hiền=111,Vân=222,Hường=333" (tên = user id Telegram). Anh lấy id bằng /id trong nhóm.
 *  - TASKS_THREAD_ID: id chủ đề "Việc chung" trong nhóm Phòng họp (bỏ trống = chủ đề mặc định của bot).
 *  - TASKS_GROUPS: nhóm riêng theo bộ phận, dạng "cskh=-100111,content=-100222,Hường=-100222". Khóa là mã bộ phận
 *    (department của việc) hoặc tên người làm. Việc khớp nhóm nào thì báo vào nhóm đó (người thật chỉ thấy việc bộ phận
 *    mình); không khớp thì báo vào Phòng họp như cũ. Sáng 8h: Phòng họp nhận danh sách đủ, mỗi nhóm nhận phần của nhóm.
 */
import { db } from "./supabase";
import { answerCallback, editTelegram, esc, isOwner, sendTelegramMessage } from "./autopilot/telegram";

const AGENT = "bot:viec-chung";

export const STATUS_VI: Record<string, string> = {
  moi: "Mới",
  dang_lam: "Đang làm",
  xong: "✅ Xong",
  cham: "⏳ Chậm",
  khong_lam_duoc: "⚠️ Không làm được",
  huy: "Đã hủy",
};

/** Tên → user id Telegram của người thật. */
export function staffMap(env = process.env.TELEGRAM_STAFF): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of String(env ?? "").split(",")) {
    const [name, id] = part.split("=").map((x) => x?.trim());
    if (name && id && /^\d+$/.test(id)) m.set(norm(name), id);
  }
  return m;
}

/** So tên không phân biệt hoa thường, dấu cách. */
export function norm(s: string): string {
  return s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Tên người làm ứng với user id (người thật), hoặc null. */
export function staffNameOf(userId: unknown, env = process.env.TELEGRAM_STAFF): string | null {
  for (const [name, id] of staffMap(env)) if (id === String(userId)) return name;
  return null;
}

/** Mã bộ phận hoặc tên người → id nhóm Telegram (TASKS_GROUPS). */
export function taskGroups(env = process.env.TASKS_GROUPS): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of String(env ?? "").split(",")) {
    const [key, id] = part.split("=").map((x) => x?.trim());
    if (key && id && /^-\d+$/.test(id)) m.set(norm(key), id);
  }
  return m;
}

/** Nhóm riêng của một việc: theo bộ phận trước, rồi theo tên người làm; không có thì null (Phòng họp). */
export function groupFor(t: any, env = process.env.TASKS_GROUPS): string | null {
  const g = taskGroups(env);
  if (t?.department && g.has(norm(String(t.department)))) return g.get(norm(String(t.department)))!;
  if (t?.assignee && g.has(norm(String(t.assignee)))) return g.get(norm(String(t.assignee)))!;
  return null;
}

/** Nhóm đang chứa tin của việc: nhóm đã lưu lúc gửi, nếu chưa có thì tính lại, cuối cùng là Phòng họp. */
export function chatOf(t: any, env = process.env.TASKS_GROUPS): string {
  return String(t?.telegram_chat_id ?? groupFor(t, env) ?? process.env.TELEGRAM_CHAT_ID ?? "");
}

/** Anh (theo user id), dùng trong các nhóm bộ phận. */
export function ownerUser(fromId: unknown): boolean {
  const def = String(process.env.TELEGRAM_CHAT_ID ?? "");
  if (def && !def.startsWith("-") && def === String(fromId)) return true;
  return String(process.env.TELEGRAM_OWNER_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .includes(String(fromId));
}

/** Gắn tên: người thật có id thì tag để họ nhận thông báo. */
export function mention(assignee: string, env = process.env.TELEGRAM_STAFF): string {
  const id = staffMap(env).get(norm(assignee));
  return id ? `<a href="tg://user?id=${id}">${esc(assignee)}</a>` : `<b>${esc(assignee)}</b>`;
}

function dueText(due: string | null | undefined): string {
  if (!due) return "";
  const [y, m, d] = String(due).slice(0, 10).split("-");
  return ` · hạn ${d}/${m}${y && y !== String(new Date().getFullYear()) ? `/${y}` : ""}`;
}

const PRIO = ["", "🔴 Gấp", "", "🔵 Khi rảnh"];

/** Nội dung tin báo một việc (hàm thuần để test). */
export function taskText(t: any, env = process.env.TELEGRAM_STAFF): string {
  const p = PRIO[Number(t.priority) || 2];
  return [
    `📌 <b>Việc #${t.id}</b>${p ? ` · ${p}` : ""}${dueText(t.due)}`,
    `${mention(String(t.assignee), env)}: ${esc(String(t.title))}`,
    t.detail ? esc(String(t.detail)).slice(0, 1500) : "",
    `<i>Giao bởi ${esc(String(t.created_by))}. Làm xong bấm nút; cần ghi chú/gửi ảnh thì trả lời tin này.</i>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function taskButtons(id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Xong", callback_data: `tk:x:${id}` },
        { text: "🔄 Đang làm", callback_data: `tk:d:${id}` },
        { text: "⚠️ Không làm được", callback_data: `tk:k:${id}` },
      ],
    ],
  };
}

async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function threadId(): number | undefined {
  const t = Number(process.env.TASKS_THREAD_ID);
  return t > 0 ? t : undefined;
}

/** Job: báo việc mới (vào nhóm bộ phận nếu có); sáng thì gửi danh sách việc từng người. */
export async function tasksJob(morning = false) {
  let sent = 0;
  const fresh: any[] = await rpc("mk_task_unnotified", { p_agent: AGENT });
  for (const t of fresh ?? []) {
    const group = groupFor(t);
    const msgId = await sendTelegramMessage(taskText(t), {
      replyMarkup: taskButtons(Number(t.id)),
      ...(group ? { chatId: group } : { threadId: threadId() }),
    });
    await rpc("mk_task_set_message", {
      p_agent: AGENT,
      p_id: t.id,
      p_message_id: msgId,
      p_chat_id: msgId ? Number(group ?? process.env.TELEGRAM_CHAT_ID) || null : null,
    });
    if (msgId) sent++;
  }
  if (!morning) return { sent };

  const open: any[] = (await rpc("mk_task_list", { p_agent: AGENT, p_assignee: null, p_created_by: null, p_status: null, p_limit: 200 })) ?? [];
  const text = morningDigest(open);
  if (text) await sendTelegramMessage(text, { threadId: threadId() });
  for (const [group, list] of digestByGroup(open)) {
    const t = morningDigest(list);
    if (t) await sendTelegramMessage(t, { chatId: group });
  }
  return { sent, open: open.length };
}

/** Việc mở chia theo nhóm bộ phận (việc không thuộc nhóm nào chỉ nằm ở Phòng họp). */
export function digestByGroup(open: any[], env = process.env.TASKS_GROUPS): Map<string, any[]> {
  const by = new Map<string, any[]>();
  for (const t of open) {
    const g = groupFor(t, env);
    if (!g) continue;
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(t);
  }
  return by;
}

/** "Việc của bạn hôm nay": gom theo người làm (hàm thuần để test). */
export function morningDigest(open: any[], env = process.env.TELEGRAM_STAFF, today = new Date().toISOString().slice(0, 10)): string {
  if (!open.length) return "";
  const by = new Map<string, any[]>();
  for (const t of open) {
    const k = String(t.assignee);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(t);
  }
  const lines = ["☀️ <b>Việc hôm nay</b>"];
  for (const [who, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push("", `${mention(who, env)} (${list.length})`);
    for (const t of list.slice(0, 8)) {
      const late = t.due && String(t.due).slice(0, 10) < today ? " ⏰ trễ hạn" : "";
      lines.push(`• #${t.id} ${esc(String(t.title)).slice(0, 120)}${dueText(t.due)}${late}${t.status === "cham" ? " ⏳" : ""}`);
    }
    if (list.length > 8) lines.push(`• … và ${list.length - 8} việc khác`);
  }
  lines.push("", "<i>Bấm nút trên tin của từng việc khi xong, hoặc gõ /viec để xem việc của mình.</i>");
  return lines.join("\n");
}

/** Ai được cập nhật việc: anh (chủ) hoặc chính người được giao (người thật có trong TELEGRAM_STAFF). */
export function canUpdate(task: any, chatId: unknown, fromId: unknown, env = process.env.TELEGRAM_STAFF): { ok: boolean; who: string } {
  if (isOwner(chatId, fromId)) return { ok: true, who: "Anh Tùng" };
  // Nhóm bộ phận: chỉ tính trong đúng nhóm chứa tin việc đó.
  if (String(chatId) !== chatOf(task)) return { ok: false, who: staffNameOf(fromId, env) ?? "?" };
  if (ownerUser(fromId)) return { ok: true, who: "Anh Tùng" };
  const name = staffNameOf(fromId, env);
  if (name && norm(String(task?.assignee ?? "")) === name) return { ok: true, who: task.assignee };
  return { ok: false, who: name ?? "?" };
}

/** Bấm nút trên tin việc. Trả về true nếu đã xử lý. */
export async function handleTaskCallback(cb: any): Promise<boolean> {
  const m = /^tk:([xdk]):(\d+)$/.exec(String(cb?.data ?? ""));
  if (!m) return false;
  const id = Number(m[2]);
  const msgId = cb.message?.message_id;
  const chatId = cb.message?.chat?.id;
  const task: any = msgId ? await rpc("mk_task_by_message", { p_agent: AGENT, p_message_id: msgId, p_chat_id: chatId ?? null }) : null;
  if (!task || Number(task.id) !== id) {
    await answerCallback(cb.id, "Không tìm thấy việc này");
    return true;
  }
  const who = canUpdate(task, chatId, cb.from?.id);
  if (!who.ok) {
    await answerCallback(cb.id, `Việc này giao cho ${task.assignee}`);
    return true;
  }
  const status = m[1] === "x" ? "xong" : m[1] === "d" ? "dang_lam" : "khong_lam_duoc";
  const r: any = await rpc("mk_task_update", { p_agent: who.who, p_id: id, p_status: status, p_note: null, p_due: null });
  await editTelegram(msgId, `${taskText(r)}\n\n<b>${STATUS_VI[status]}</b> — ${esc(who.who)}`, chatId);
  await answerCallback(cb.id, STATUS_VI[status]);
  return true;
}

/** Người làm trả lời tin việc (chữ hoặc chú thích ảnh) → ghi chú vào việc. Trả về true nếu đã xử lý. */
export async function handleTaskReply(msg: any): Promise<boolean> {
  const replyTo = Number(msg?.reply_to_message?.message_id ?? 0);
  if (!replyTo) return false;
  const task: any = await rpc("mk_task_by_message", { p_agent: AGENT, p_message_id: replyTo, p_chat_id: msg.chat?.id ?? null });
  if (!task) return false;
  const who = canUpdate(task, msg.chat?.id, msg.from?.id);
  if (!who.ok) return true; // tin trả lời việc của người khác: bỏ qua, không làm gì
  const photo = Array.isArray(msg.photo) && msg.photo.length ? " [có ảnh]" : msg.document ? " [có file]" : "";
  const note = `${String(msg.text ?? msg.caption ?? "").trim()}${photo}`.trim() || "(trả lời không có chữ)";
  await rpc("mk_task_update", { p_agent: who.who, p_id: task.id, p_status: null, p_note: note.slice(0, 1500), p_due: null });
  await sendTelegramMessage(`📝 Đã ghi vào việc #${task.id}: <i>${esc(note.slice(0, 200))}</i>`, {
    chatId: msg.chat?.id,
    threadId: Number(msg.message_thread_id) || undefined,
  });
  return true;
}

/** /id: ai trong nhóm cũng gõ được, để anh lấy user id điền TELEGRAM_STAFF. */
export function idReply(msg: any): string {
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "bạn";
  const chat = msg.chat?.id;
  const group = chat != null && String(chat).startsWith("-") ? `\n👥 Nhóm này: <code>${chat}</code>` : "";
  return `🆔 ${esc(name)}: <code>${msg.from?.id}</code>${group}`;
}

/** /viec: việc còn mở của người gõ (anh gõ thì xem tất cả). */
export async function myTasksText(msg: any): Promise<string> {
  const owner = isOwner(msg.chat?.id, msg.from?.id);
  const name = owner ? null : staffNameOf(msg.from?.id);
  if (!owner && !name) return "Bạn chưa có trong danh sách người làm. Gõ /id rồi nhờ anh Tùng thêm.";
  const open: any[] = await rpc("mk_task_list", {
    p_agent: AGENT,
    p_assignee: name,
    p_created_by: null,
    p_status: null,
    p_limit: 50,
  });
  if (!open?.length) return name ? `Không còn việc nào của ${esc(name)} 🎉` : "Không còn việc nào đang mở 🎉";
  return morningDigest(open).replace("☀️ <b>Việc hôm nay</b>", "📋 <b>Việc đang mở</b>");
}
