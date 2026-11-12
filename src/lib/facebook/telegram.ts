/**
 * Bot Telegram của Nhân viên Facebook. Dùng chung nhóm Phòng họp (TELEGRAM_CHAT_ID) và danh sách người
 * được ra lệnh (TELEGRAM_OWNER_IDS) với nhân viên Shopee; token và chủ đề riêng:
 *   FB_TELEGRAM_BOT_TOKEN, FB_TELEGRAM_THREAD_ID (bỏ trống nếu là chủ đề mặc định).
 */
import { db } from "../supabase";

async function tg(method: string, body: Record<string, unknown>): Promise<any | null> {
  const token = process.env.FB_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

function target(): Record<string, unknown> | null {
  const id = process.env.TELEGRAM_CHAT_ID;
  if (!id) return null;
  const thread = Number(process.env.FB_TELEGRAM_THREAD_ID);
  return thread > 0 ? { chat_id: id, message_thread_id: thread } : { chat_id: id };
}

export async function fbSend(text: string, replyMarkup?: unknown): Promise<number | null> {
  const to = target();
  if (!to) return null;
  const r = await tg("sendMessage", {
    ...to,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  return r?.result?.message_id ?? null;
}

export async function fbEdit(messageId: number, text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true });
}

export async function fbAnswer(callbackQueryId: string, text: string): Promise<void> {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text.slice(0, 190) });
}

export function fbButtons(id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Đồng ý", callback_data: `fa:${id}` },
        { text: "✖️ Bỏ qua", callback_data: `fr:${id}` },
      ],
    ],
  };
}

/** Cảnh báo không lặp cùng `key` trong `cooldownMinutes` (bảng alert_state, khóa có tiền tố fb:). */
export async function fbAlertOnce(key: string, text: string, cooldownMinutes = 120): Promise<boolean> {
  const k = `fb:${key}`;
  const { data } = await db().from("alert_state").select("last_sent_at").eq("key", k).maybeSingle();
  if (data && Date.now() - Date.parse(data.last_sent_at) < cooldownMinutes * 60_000) return false;
  const sent = (await fbSend(text)) != null;
  if (sent) await db().from("alert_state").upsert({ key: k, last_sent_at: new Date().toISOString() });
  return sent;
}
