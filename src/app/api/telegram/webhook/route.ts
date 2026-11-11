import { safeEqual, shops } from "@/lib/autopilot/config";
import { todayOverview } from "@/lib/autopilot/dashboard";
import { morningReportJob } from "@/lib/autopilot/jobs";
import { esc, sendTelegram, vnd } from "@/lib/autopilot/telegram";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Webhook của bot Telegram. Chỉ nhận lệnh từ TELEGRAM_CHAT_ID và có header bí mật
 * X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET.
 */
export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 403 });

  const update = await request.json().catch(() => null);
  const msg = update?.message;
  const chatId = String(msg?.chat?.id ?? "");
  if (!msg?.text || chatId !== String(process.env.TELEGRAM_CHAT_ID)) return Response.json({ ok: true });

  const [cmd] = String(msg.text).trim().split(/\s+/);
  const command = cmd.toLowerCase().replace(/@.*$/, "");
  try {
    if (command === "/status") await status();
    else if (command === "/report") await morningReportJob();
    else if (command === "/stop") await emergency(true);
    else if (command === "/start_auto" || command === "/release") await emergency(false);
    else if (["/pause_all", "/resume_all", "/mode"].includes(command))
      await sendTelegram("Lệnh này mở ở giai đoạn 2 (tự động hóa). Hiện tool chỉ theo dõi và báo cáo.");
    else
      await sendTelegram(
        "Lệnh:\n/status — tình hình hôm nay\n/report — báo cáo hôm qua\n/stop — DỪNG KHẨN CẤP mọi tự động\n/release — gỡ dừng khẩn cấp"
      );
  } catch (err) {
    await sendTelegram(`Lỗi: <code>${esc(err instanceof Error ? err.message : String(err))}</code>`);
  }
  return Response.json({ ok: true });
}

async function status() {
  const parts = ["📊 <b>Hôm nay</b>"];
  for (const s of shops()) {
    const o = await todayOverview(s.shopId);
    parts.push(
      `\n<b>${esc(s.name)}</b>\n• Chi QC ${vnd(o.expense)} — ROAS ${o.roas ? o.roas.toFixed(1) : "-"} — ${o.adOrders} đơn QC (${vnd(o.costPerOrder)}/đơn)\n• Đơn shop: ${o.orders} — khách trả ${vnd(o.revenue)}\n• Ví QC: ${o.balance == null ? "-" : vnd(o.balance)}`
    );
  }
  const { data } = await db().from("autopilot_settings").select("emergency_stop, mode");
  if (data?.some((r) => r.emergency_stop)) parts.push("\n🛑 Đang DỪNG KHẨN CẤP");
  await sendTelegram(parts.join("\n"));
}

async function emergency(stop: boolean) {
  await db()
    .from("autopilot_settings")
    .update({ emergency_stop: stop, updated_at: new Date().toISOString() })
    .in("shop_id", shops().map((s) => s.shopId));
  await db().from("autopilot_actions").insert({
    shop_id: 0,
    action: stop ? "emergency_stop" : "emergency_release",
    reason: "Lệnh Telegram",
    source: "telegram",
    status: "executed",
    executed_at: new Date().toISOString(),
  });
  await sendTelegram(stop ? "🛑 Đã DỪNG KHẨN CẤP: tắt toàn bộ tự động." : "✅ Đã gỡ dừng khẩn cấp.");
}
