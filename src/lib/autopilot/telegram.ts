import { db } from "../supabase";

/** Gửi tin Telegram (HTML). Không có TELEGRAM_BOT_TOKEN/CHAT_ID thì bỏ qua. */
export async function sendTelegram(
  text: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    }),
  }).catch(() => null);
  return !!res?.ok;
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
