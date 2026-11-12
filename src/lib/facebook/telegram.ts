/**
 * Bot Telegram của Nhân viên Facebook. Dùng chung nhóm Phòng họp (TELEGRAM_CHAT_ID) và danh sách người
 * được ra lệnh (TELEGRAM_OWNER_IDS) với nhân viên Shopee; token và chủ đề riêng:
 *   FB_TELEGRAM_BOT_TOKEN, FB_TELEGRAM_THREAD_ID (bỏ trống nếu là chủ đề mặc định).
 */
import { createHash } from "node:crypto";
import { db } from "../supabase";

/** Tên bot Kiều Trang (không có @). */
export function fbBotUsername(): string {
  return (process.env.FB_TELEGRAM_BOT_USERNAME?.trim() || "magicfbbot").replace(/^@/, "").toLowerCase();
}

/**
 * Secret webhook: FB_TELEGRAM_WEBHOOK_SECRET nếu có, không thì suy ra từ token bot (không cần đặt thêm biến).
 * Đổi token bot (/revoke) thì secret đổi theo; chạy lại /api/jobs/fb-setup.
 */
export function fbWebhookSecret(): string | null {
  const set = process.env.FB_TELEGRAM_WEBHOOK_SECRET?.trim();
  if (set) return set;
  const token = process.env.FB_TELEGRAM_BOT_TOKEN?.trim();
  return token ? createHash("sha256").update(`kieu-trang-webhook:${token}`).digest("hex").slice(0, 48) : null;
}

/** Nối webhook và danh sách lệnh cho bot (gọi một lần sau khi đặt token). */
export async function fbSetupWebhook(baseUrl: string) {
  const secret = fbWebhookSecret();
  if (!secret) return { ok: false, error: "Chưa đặt FB_TELEGRAM_BOT_TOKEN" };
  const hook = await tg("setWebhook", {
    url: `${baseUrl.replace(/\/$/, "")}/api/telegram/facebook`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
  const cmds = await tg("setMyCommands", {
    commands: [
      { command: "status", description: "Số quảng cáo Facebook hôm nay" },
      { command: "report", description: "Báo cáo hôm qua" },
      { command: "stop", description: "Dừng báo cáo tự động" },
      { command: "release", description: "Chạy lại" },
      { command: "help", description: "Danh sách lệnh" },
    ],
  });
  const me = await tg("getMe", {});
  return { ok: Boolean(hook?.ok), webhook: hook?.description ?? null, commands: Boolean(cmds?.ok), bot: me?.result?.username ?? null };
}

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
