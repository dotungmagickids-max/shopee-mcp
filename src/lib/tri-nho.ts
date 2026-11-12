import { answerCallback, editTelegram, esc, sendTelegram } from "./autopilot/telegram";
import { db } from "./supabase";

/**
 * Gom Trí nhớ công ty qua Telegram (bước 5 Nền tảng dữ liệu).
 * Chỉ ghi khi có người gõ lệnh, trong chat riêng của anh hoặc nhóm anh đã cho phép.
 * Mẩu ghi vào brain.inbox (Supabase); anh bấm Lưu/Bỏ thì mới thành quyết định, ca khó, bài học, ghi chú.
 */

const KINDS: Record<string, { kind: string; label: string }> = {
  "/ghi": { kind: "ghi", label: "ghi chú" },
  "/quyetdinh": { kind: "quyet_dinh", label: "quyết định" },
  "/cakho": { kind: "ca_kho", label: "ca khó" },
  "/baihoc": { kind: "bai_hoc", label: "bài học" },
};
const LABEL: Record<string, string> = { ghi: "Ghi chú", quyet_dinh: "Quyết định", ca_kho: "Ca khó", bai_hoc: "Bài học" };

export const MEMORY_HELP = [
  "Trí nhớ công ty:",
  "/quyetdinh … — ghi một quyết định (kèm lý do)",
  "/cakho … — ghi cách xử lý một ca khó",
  "/baihoc … — ghi một bài học",
  "/ghi … — ghi chú khác",
  "(Trả lời một tin bằng lệnh trên để ghi chính tin đó.)",
  "/tri_nho — xem mẩu chờ duyệt",
].join("\n");

async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

function nameOf(from: any): string | null {
  if (!from) return null;
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || null;
}

export function isMemoryCommand(text: string | undefined): boolean {
  const cmd = String(text ?? "").trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, "");
  return cmd in KINDS || cmd === "/tri_nho";
}

/** Xử lý lệnh Trí nhớ. ownerChat = chat riêng của anh (TELEGRAM_CHAT_ID). */
export async function handleMemoryMessage(msg: any, ownerChat: boolean): Promise<void> {
  const text = String(msg.text ?? "").trim();
  const [cmdRaw] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, "");
  const chatId = msg.chat?.id;
  const reply = (t: string) => sendTelegram(t, { chatId });

  if (cmd === "/tri_nho") {
    if (ownerChat) await sendPending();
    return;
  }
  const spec = KINDS[cmd];
  if (!spec) return;

  const note = text.slice(cmdRaw.length).trim();
  const quoted = msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "";
  const content = quoted ? [quoted, note && `(Ghi chú: ${note})`].filter(Boolean).join("\n") : note;
  const author = quoted ? nameOf(msg.reply_to_message?.from) : nameOf(msg.from);
  if (content.length < 5) {
    await reply(`Gõ nội dung sau lệnh, ví dụ: <code>${cmd} Đổi size miễn phí 7 ngày nếu còn tem</code>, hoặc trả lời một tin bằng ${cmd}.`);
    return;
  }

  const title = msg.chat?.title ?? (ownerChat ? "rieng_anh" : null);
  const r = await rpc("mk_tg_capture", {
    p_chat_id: chatId,
    p_chat_title: title,
    p_author: author,
    p_kind: spec.kind,
    p_content: content,
    p_owner_chat: ownerChat,
  });
  if (r?.status === "ok") {
    await reply(`🧠 Đã ghi ${spec.label} #${r.id}, chờ anh Tùng duyệt.`);
  } else if (r?.status === "chua_cho_phep") {
    await reply("Nhóm này chưa được bật ghi Trí nhớ. Đã gửi anh Tùng duyệt.");
    if (r.moi) {
      await sendTelegram(`🧠 Nhóm <b>${esc(title ?? String(chatId))}</b> muốn ghi Trí nhớ công ty. Cho phép nhóm này?`, {
        replyMarkup: {
          inline_keyboard: [[
            { text: "✅ Cho phép", callback_data: `g:a:${chatId}` },
            { text: "❌ Không", callback_data: `g:r:${chatId}` },
          ]],
        },
      });
    }
  } else if (r?.status === "qua_ngan") {
    await reply("Nội dung quá ngắn, chưa ghi.");
  }
}

/** Gửi các mẩu chờ duyệt, mỗi mẩu một tin có nút Lưu/Bỏ. */
export async function sendPending(limit = 10): Promise<number> {
  const r = await rpc<{ tong: number; muc: any[] }>("mk_inbox_pending", { p_limit: limit });
  if (!r?.tong) {
    await sendTelegram("🧠 Không có mẩu Trí nhớ nào chờ duyệt.");
    return 0;
  }
  await sendTelegram(`🧠 <b>${r.tong} mẩu Trí nhớ chờ duyệt</b>${r.tong > r.muc.length ? ` (hiện ${r.muc.length})` : ""}`);
  for (const m of r.muc) {
    await sendTelegram(
      `<b>${LABEL[m.kind] ?? "Ghi chú"} #${m.id}</b> — ${esc(m.author ?? "?")} (${esc(String(m.source).replace(/^telegram:/, ""))})\n${esc(
        String(m.content).slice(0, 1500)
      )}`,
      {
        replyMarkup: {
          inline_keyboard: [[
            { text: "✅ Lưu vào Trí nhớ", callback_data: `m:a:${m.id}` },
            { text: "❌ Bỏ", callback_data: `m:r:${m.id}` },
          ]],
        },
      }
    );
  }
  return r.tong;
}

/** Nút bấm của Trí nhớ (chỉ nhận từ chat riêng của anh). Trả về true nếu đã xử lý. */
export async function handleMemoryCallback(cb: any): Promise<boolean> {
  const m = /^(m|g):([ar]):(-?\d+)$/.exec(String(cb?.data ?? ""));
  if (!m) return false;
  const approve = m[2] === "a";
  const messageId = cb.message?.message_id;
  const original = esc(String(cb.message?.text ?? ""));
  if (m[1] === "m") {
    const r = await rpc("mk_inbox_decide", { p_id: Number(m[3]), p_approve: approve, p_by: nameOf(cb.from) ?? "anh Tùng" });
    const msg =
      r?.status === "da_luu" ? `Đã lưu (${r.ref})` : r?.status === "bo" ? "Đã bỏ" : r?.status === "da_xu_ly" ? "Mẩu này đã xử lý" : "Không thấy mẩu";
    await answerCallback(cb.id, msg);
    if (messageId) await editTelegram(messageId, `${original}\n\n<i>${esc(msg)}</i>`);
  } else {
    const r = await rpc("mk_tg_allow", { p_chat_id: Number(m[3]), p_allow: approve, p_by: nameOf(cb.from) ?? "anh Tùng" });
    const msg = r?.status === "ok" ? (approve ? "Đã cho phép nhóm" : "Đã từ chối nhóm") : "Không thấy nhóm";
    await answerCallback(cb.id, msg);
    if (messageId) await editTelegram(messageId, `${original}\n\n<i>${esc(msg)}</i>`);
    if (r?.status === "ok" && approve) {
      await sendTelegram(`🧠 Nhóm đã được bật ghi Trí nhớ.\n${MEMORY_HELP}`, { chatId: Number(m[3]) });
    }
  }
  return true;
}

/** Dòng nhắc trong báo cáo sáng; rỗng nếu không có gì chờ duyệt hoặc lỗi. */
export async function memoryDigestLine(): Promise<string> {
  try {
    const r = await rpc<{ tong: number }>("mk_inbox_pending", { p_limit: 1 });
    return r?.tong ? `\n🧠 <b>${r.tong}</b> mẩu Trí nhớ chờ duyệt — gõ /tri_nho` : "";
  } catch {
    return "";
  }
}
