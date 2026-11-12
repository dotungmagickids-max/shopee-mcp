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

/**
 * Nơi nhận tin: TELEGRAM_CHAT_ID (chat riêng của anh, hoặc nhóm "Phòng họp").
 * Nếu là nhóm có Chủ đề, TELEGRAM_THREAD_ID = id chủ đề của nhân viên này; tin gửi vào nhóm đó
 * mà không chỉ định chủ đề sẽ vào chủ đề này.
 */
function target(chatId?: string | number): Record<string, unknown> | null {
  const def = process.env.TELEGRAM_CHAT_ID;
  const id = chatId ?? def;
  if (!id) return null;
  const thread = Number(process.env.TELEGRAM_THREAD_ID);
  return String(id) === String(def) && thread > 0 ? { chat_id: id, message_thread_id: thread } : { chat_id: id };
}

/**
 * Người được ra lệnh / bấm nút. Chat riêng: đúng TELEGRAM_CHAT_ID. Nhóm: phải đúng nhóm đó VÀ
 * người gửi nằm trong TELEGRAM_OWNER_IDS (danh sách user id, cách nhau bằng dấu phẩy).
 */
export function isOwner(chatId: unknown, fromId: unknown): boolean {
  const def = String(process.env.TELEGRAM_CHAT_ID ?? "");
  if (!def || String(chatId) !== def) return false;
  if (!def.startsWith("-")) return true; // chat riêng
  const owners = String(process.env.TELEGRAM_OWNER_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return owners.includes(String(fromId));
}

/** Gửi tin Telegram (HTML). Trả về message_id, hoặc null nếu chưa cấu hình / lỗi. */
export async function sendTelegramMessage(
  text: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<number | null> {
  const to = target(opts.chatId);
  if (!to) return null;
  const r = await tg("sendMessage", {
    ...to,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
  });
  return r?.result?.message_id ?? null;
}

/**
 * Gửi ảnh kèm chú thích (HTML, tối đa 1024 ký tự) và nút bấm. Ảnh lỗi hoặc chú thích quá dài
 * thì gửi tin chữ như thường. Trả về message_id.
 */
export async function sendTelegramPhoto(
  photoUrl: string | null | undefined,
  caption: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<number | null> {
  const to = target(opts.chatId);
  if (!to) return null;
  if (photoUrl && caption.length <= 1024) {
    const r = await tg("sendPhoto", {
      ...to,
      photo: photoUrl,
      caption,
      parse_mode: "HTML",
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
    if (r?.result?.message_id) return r.result.message_id;
  }
  return sendTelegramMessage(caption, opts);
}

export async function sendTelegram(
  text: string,
  opts: { chatId?: string | number; replyMarkup?: unknown } = {}
): Promise<boolean> {
  return (await sendTelegramMessage(text, opts)) != null;
}

/** Sửa nội dung tin (bỏ nút bấm). Tin có ảnh (sửa chữ bị Telegram từ chối) thì sửa chú thích. */
export async function editTelegram(messageId: number, text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const r = await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  if (r?.ok) return;
  await tg(
    "editMessageCaption",
    text.length <= 1024
      ? { chat_id: chatId, message_id: messageId, caption: text, parse_mode: "HTML" }
      : { chat_id: chatId, message_id: messageId, caption: `${unhtml(text).slice(0, 1020)}…` }
  );
}

function unhtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
