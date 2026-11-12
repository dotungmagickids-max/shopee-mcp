import { safeEqual } from "@/lib/autopilot/config";
import { esc, isOwner } from "@/lib/autopilot/telegram";
import { fbDecide, fbReportJob, fbStatusText, setStopped } from "@/lib/facebook/jobs";
import { fbAnswer, fbBotUsername, fbSend, fbWebhookSecret } from "@/lib/facebook/telegram";
import { askWhy, captureWhy } from "@/lib/feedback";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HELP = [
  "Kiều Trang (Nhân viên Facebook): lệnh",
  "/status — số quảng cáo hôm nay đến giờ",
  "/report — báo cáo hôm qua",
  "/stop — dừng báo cáo, cảnh báo tự động",
  "/release — chạy lại",
  "Giai đoạn này em báo hiệu quả, lãi/lỗ, content và đề xuất; nút Đồng ý chỉ ghi nhận.",
].join("\n");

/**
 * Webhook bot Kiều Trang (@magicfbbot), header X-Telegram-Bot-Api-Secret-Token = fbWebhookSecret().
 * Chỉ người trong TELEGRAM_OWNER_IDS (nhóm Phòng họp) được ra lệnh, bấm nút.
 */
export async function POST(request: Request) {
  const expected = fbWebhookSecret();
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
      if (m[1] === "r" && text === "Đã bỏ qua") {
        const { data: p } = await db().from("fb_proposals").select("kind, ad_name, ad_id, account_name, campaign_name, reason").eq("id", Number(m[2])).maybeSingle();
        const summary = p
          ? `${p.kind === "pause" ? "tắt" : "tăng ngân sách"} quảng cáo ${p.ad_name ?? p.ad_id} (${p.account_name} / ${p.campaign_name ?? "-"}): ${p.reason ?? ""}`
          : `đề xuất #${m[2]}`;
        await askWhy("facebook", "fb_proposal", Number(m[2]), summary, fbSend);
      }
    }
    return Response.json({ ok: true });
  }

  const msg = update?.message;
  if (!msg?.text || !isOwner(msg.chat?.id, msg.from?.id)) return Response.json({ ok: true });
  // Anh trả lời câu hỏi "Sai vì…" của Kiều Trang.
  if (await captureWhy("facebook", msg, fbSend).catch(() => false)) return Response.json({ ok: true });
  const cmd = String(msg.text).trim().split(/\s+/)[0];
  const command = cmd.toLowerCase().replace(/@.*$/, "");
  // Trong nhóm: lệnh gọi đích danh bot khác thì bỏ qua.
  const me = fbBotUsername();
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
