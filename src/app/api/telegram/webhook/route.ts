import { decide } from "@/lib/autopilot/actions";
import { safeEqual, shops } from "@/lib/autopilot/config";
import { todayOverview } from "@/lib/autopilot/dashboard";
import { morningReportJob } from "@/lib/autopilot/jobs";
import { proposePauseAll, proposeResumeAll } from "@/lib/autopilot/rules";
import { suggestDays } from "@/lib/autopilot/settings";
import { answerCallback, esc, isOwner, sendTelegram, vnd } from "@/lib/autopilot/telegram";
import { db } from "@/lib/supabase";
import { handleMemoryCallback, handleMemoryMessage, isMemoryCommand, MEMORY_HELP } from "@/lib/tri-nho";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HELP = [
  "Lệnh:",
  "/status — tình hình hôm nay",
  "/report — báo cáo hôm qua",
  "/pause_all — tạm dừng mọi chiến dịch (có nút xác nhận)",
  "/resume_all — bật lại chiến dịch tool đã dừng (có nút xác nhận)",
  "/mode — xem chế độ; /mode suggest | off | auto",
  "/stop — DỪNG KHẨN CẤP mọi tự động",
  "/release — gỡ dừng khẩn cấp",
  "",
  MEMORY_HELP,
].join("\n");

/**
 * Webhook bot Telegram, có header X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET.
 * Lệnh điều khiển và nút bấm chỉ nhận từ anh (xem isOwner: chat riêng TELEGRAM_CHAT_ID, hoặc nhóm
 * Phòng họp + TELEGRAM_OWNER_IDS); người/nhóm khác chỉ được dùng lệnh Trí nhớ.
 */
export async function POST(request: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!expected || !safeEqual(got, expected)) return new Response("forbidden", { status: 403 });

  const update = await request.json().catch(() => null);

  // Nút Đồng ý / Bỏ qua
  const cb = update?.callback_query;
  if (cb) {
    if (!isOwner(cb.message?.chat?.id ?? cb.from?.id, cb.from?.id)) return Response.json({ ok: true });
    try {
      if (await handleMemoryCallback(cb)) return Response.json({ ok: true });
    } catch (err) {
      await answerCallback(cb.id, `Lỗi: ${err instanceof Error ? err.message : String(err)}`);
      return Response.json({ ok: true });
    }
    const m = /^([ar]):(\d+)$/.exec(String(cb.data ?? ""));
    if (m) {
      const res = await decide(Number(m[2]), m[1] === "a", "telegram").catch((e) => ({ ok: false, message: String(e) }));
      await answerCallback(cb.id, res.message);
    }
    return Response.json({ ok: true });
  }

  const msg = update?.message;
  if (!msg?.text) return Response.json({ ok: true });
  const ownerChat = isOwner(msg.chat?.id, msg.from?.id);
  // Nhóm khác: chỉ nhận lệnh Trí nhớ (nhóm phải được anh cho phép).
  if (!ownerChat) {
    if (isMemoryCommand(msg.text)) {
      await handleMemoryMessage(msg, false).catch((err) =>
        sendTelegram(`Lỗi ghi Trí nhớ: <code>${esc(err instanceof Error ? err.message : String(err))}</code>`)
      );
    }
    return Response.json({ ok: true });
  }
  const [cmd, arg] = String(msg.text).trim().split(/\s+/);
  const command = cmd.toLowerCase().replace(/@.*$/, "");
  try {
    if (isMemoryCommand(msg.text)) await handleMemoryMessage(msg, true);
    else if (command === "/status") await status();
    else if (command === "/report") await morningReportJob();
    else if (command === "/stop") await emergency(true);
    else if (command === "/release") await emergency(false);
    else if (command === "/pause_all") {
      for (const s of shops()) {
        const g = await proposePauseAll(s.shopId, "telegram");
        if (!g) await sendTelegram(`${esc(s.name)}: không có chiến dịch đang chạy.`);
      }
    } else if (command === "/resume_all") {
      for (const s of shops()) {
        const g = await proposeResumeAll(s.shopId, "telegram");
        if (!g) await sendTelegram(`${esc(s.name)}: không có chiến dịch nào do tool tạm dừng.`);
      }
    } else if (command === "/mode") await mode(arg?.toLowerCase());
    // Nhóm Phòng họp có nhiều nhân viên: lệnh lạ không gọi đích danh bot này thì bỏ qua, tránh mọi bot cùng trả lời.
    else if (!String(msg.chat?.id).startsWith("-") || command === "/help" || cmd.includes("@")) await sendTelegram(HELP);
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
  const { data } = await db().from("autopilot_settings").select("shop_id, emergency_stop, mode, halt_reason");
  for (const r of data ?? []) {
    parts.push(`\n${r.shop_id}: chế độ <b>${r.mode}</b>${r.emergency_stop ? ` — 🛑 ĐANG DỪNG${r.halt_reason ? ` (${esc(r.halt_reason)})` : ""}` : ""}`);
  }
  const { count } = await db().from("autopilot_actions").select("id", { count: "exact", head: true }).eq("status", "proposed").is("parent_id", null);
  if (count) parts.push(`\n💡 ${count} đề xuất đang chờ duyệt`);
  await sendTelegram(parts.join("\n"));
}

async function emergency(stop: boolean) {
  await db()
    .from("autopilot_settings")
    .update({ emergency_stop: stop, halt_reason: null, updated_at: new Date().toISOString() })
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

async function mode(arg: string | undefined) {
  if (!arg) {
    const { data } = await db().from("autopilot_settings").select("shop_id, shop_name, mode");
    await sendTelegram((data ?? []).map((r) => `${esc(r.shop_name ?? String(r.shop_id))}: <b>${r.mode}</b>`).join("\n") + "\n\n/mode suggest | off | auto");
    return;
  }
  if (!["suggest", "off", "auto"].includes(arg)) {
    await sendTelegram("Dùng: /mode suggest | off | auto");
    return;
  }
  const lines: string[] = [];
  for (const s of shops()) {
    if (arg === "auto") {
      const days = await suggestDays(s.shopId);
      if (days < 7) {
        lines.push(`${esc(s.name)}: chưa bật auto — mới chạy đề xuất ${days.toFixed(1)}/7 ngày.`);
        continue;
      }
    }
    const { data: before } = await db().from("autopilot_settings").select("mode").eq("shop_id", s.shopId).maybeSingle();
    await db().from("autopilot_settings").update({ mode: arg, updated_at: new Date().toISOString() }).eq("shop_id", s.shopId);
    await db().from("autopilot_actions").insert({
      shop_id: s.shopId,
      action: "settings",
      before: { mode: before?.mode },
      after: { mode: arg },
      reason: "Lệnh Telegram /mode",
      source: "telegram",
      status: "executed",
      executed_at: new Date().toISOString(),
    });
    lines.push(`${esc(s.name)}: chế độ <b>${arg}</b>`);
  }
  await sendTelegram(lines.join("\n"));
}
