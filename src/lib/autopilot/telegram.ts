import { db } from "../supabase";

async function tg(method: string, body: Record<string, unknown>): Promise<any | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

/** Gửi tin Telegram (HTML). Trả về message_id, hoặc null nếu chưa cấu hình / lỗi. */
export async function sendTelegramMessage(
  text: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<number | null> {
  const chatId = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return null;
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  });
  return r?.result?.message_id ?? null;
}

export async function sendTelegram(
  text: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<boolean> {
  return (await sendTelegramMessage(text, opts)) != null;
}

/** Sửa nội dung tin (bỏ nút bấm). */
export async function editTelegram(messageId: number, text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

export async function answerCallback(callbackQueryId: string, text: string): Promise<void> {
  await tg("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text.slice(0, 190) });
}

export function approveButtons(actionId: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Đồng ý", callback_data: `a:${actionId}` },
        { text: "✖️ Bỏ qua", callback_data: `r:${actionId}` },
      ],
    ],
  };
}

/**
 * Gửi cảnh báo nhưng không lặp lại cùng `key` trong `cooldownMinutes`.
 * Trả về true nếu đã gửi.
 */
export async function sendAlertOnce(key: string, text: string, cooldownMinutes = 120): Promise<boolean> {
  const { data } = await db().from("alert_state").select("last_sent_at").eq("key", key).maybeSingle();
  if (data && Date.now() - Date.parse(data.last_sent_at) < cooldownMinutes * 60_000) return false;
  const sent = await sendTelegram(text);
  if (sent) {
    await db().from("alert_state").upsert({ key, last_sent_at: new Date().toISOString() });
  }
  return sent;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function vnd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}tr`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1000).toLocaleString("vi-VN")}k`;
  return Math.round(n).toLocaleString("vi-VN");
}
