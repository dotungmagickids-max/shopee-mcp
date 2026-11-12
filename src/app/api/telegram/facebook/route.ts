import { safeEqual } from "@/lib/autopilot/config";
import { esc, isOwner } from "@/lib/autopilot/telegram";
import { fbDecide, fbReportJob, fbStatusText, setStopped } from "@/lib/facebook/jobs";
import { fbAnswer, fbSend } from "@/lib/facebook/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HELP = [
  "Nhân viên Facebook — lệnh:",
  "/status — số quảng cáo hôm nay đến giờ",
  "/report — báo cáo hôm qua",
  "/stop — dừng báo cáo, cảnh báo tự động",
  "/release — chạy lại",
  "Giai đoạn 1: em chỉ báo cáo và đề xuất, chưa tự tắt/tăng quảng cáo.",
].join("\n");

/**
 * Webhook bot Nhân viên Facebook, header X-Telegram-Bot-Api-Secret-Token = FB_TELEGRAM_WEBHOOK_SECRET.
 * Chỉ người trong TELEGRAM_OWNER_IDS (nhóm Phòng họp) được ra lệnh, bấm nút.
 */
export async function POST(request: Request) {
  const expected = process.env.FB_TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 403 });

  const update = await request.json().catch(() => null);
  const cb = update?.callback_query;
  if (cb) {
    if (!isOwner(cb.message?.chat?.id ?? cb.from?.id, cb.from?.id)) return Response.json({ ok: true });
    const m = /^f([ar]):(\d+)$/.exec(String(cb.data ?? ""));
    if (m) {
      const text = await fbDecide(Number(m[2]), m[1] === "a").catch((e) => `Lỗi: ${e instanceof Error ? e.message : String(e)}`);
      await fbAnswer(cb.id, text);
    }
    return Response.json({ ok: true });
  }

  const msg = update?.message;
  if (!msg?.text || !isOwner(msg.chat?.id, msg.from?.id)) return Response.json({ ok: true });
  const cmd = String(msg.text).trim().split(/\s+/)[0];
  const command = cmd.toLowerCase().replace(/@.*$/, "");
  // Trong nhóm: lệnh gọi đích danh bot khác thì bỏ qua.
  const me = process.env.FB_TELEGRAM_BOT_USERNAME?.toLowerCase();
  if (cmd.includes("@") && me && !cmd.toLowerCase().endsWith(`@${me}`)) return Response.json({ ok: true });
  try {
    if (command === "/status") await fbSend(await fbStatusText());
    else if (command === "/report") await fbReportJob();
    else if (command === "/stop") {
      await setStopped(true);
      await fbSend("🛑 Đã dừng báo cáo và cảnh báo Facebook tự động.");
    } else if (command === "/release") {
      await setStopped(false);
      await fbSend("✅ Nhân viên Facebook chạy lại.");
    } else if (command === "/help" || (cmd.includes("@") && me)) await fbSend(HELP);
  } catch (err) {
    await fbSend(`Lỗi: <code>${esc(err instanceof Error ? err.message : String(err))}</code>`);
  }
  return Response.json({ ok: true });
}
