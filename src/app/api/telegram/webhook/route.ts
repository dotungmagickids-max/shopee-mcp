import { decide } from "@/lib/autopilot/actions";
import { decideTask, replyCommand } from "@/lib/autopilot/care";
import { safeEqual, shopName, shops } from "@/lib/autopilot/config";
import { todayOverview } from "@/lib/autopilot/dashboard";
import { morningReportJob } from "@/lib/autopilot/jobs";
import { proposePauseAll, proposeResumeAll } from "@/lib/autopilot/rules";
import { suggestDays } from "@/lib/autopilot/settings";
import { answerCallback, esc, isOwner, sendTelegram, sendTelegramMessage, vnd } from "@/lib/autopilot/telegram";
import { askWhy, captureWhy } from "@/lib/feedback";
import { handleTaskCallback, handleTaskReply, idReply, myTasksText } from "@/lib/tasks";
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
  "/traloi <mã đánh giá> <nội dung> — tự viết câu trả lời đánh giá",
  "/viec — việc đang mở trên bảng việc chung",
  "/id — xem user id Telegram (để thêm người làm)",
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
    // Bảng việc chung: người được giao (người thật) cũng bấm được nút trên việc của mình.
    if (String(cb.data ?? "").startsWith("tk:")) {
      await handleTaskCallback(cb).catch((e) => answerCallback(cb.id, `Lỗi: ${e instanceof Error ? e.message : String(e)}`));
      return Response.json({ ok: true });
    }
    if (!isOwner(cb.message?.chat?.id ?? cb.from?.id, cb.from?.id)) return Response.json({ ok: true });
    try {
      if (await handleMemoryCallback(cb)) return Response.json({ ok: true });
    } catch (err) {
      await answerCallback(cb.id, `Lỗi: ${err instanceof Error ? err.message : String(err)}`);
      return Response.json({ ok: true });
    }
    const t = /^c([ar]):(\d+)$/.exec(String(cb.data ?? ""));
    if (t) {
      const text = await decideTask(Number(t[2]), t[1] === "a").catch((e) => `Lỗi: ${e instanceof Error ? e.message : String(e)}`);
      await answerCallback(cb.id, text);
      if (t[1] === "r" && text === "Đã bỏ qua") await askWhy("shopee", "shop_task", Number(t[2]), await taskSummary(Number(t[2])), shopeeSend);
      return Response.json({ ok: true });
    }
    const m = /^([ar]):(\d+)$/.exec(String(cb.data ?? ""));
    if (m) {
      const res = await decide(Number(m[2]), m[1] === "a", "telegram").catch((e) => ({ ok: false, message: String(e) }));
      await answerCallback(cb.id, res.message);
      if (m[1] === "r" && res.ok) await askWhy("shopee", "autopilot_action", Number(m[2]), await actionSummary(Number(m[2])), shopeeSend);
    }
    return Response.json({ ok: true });
  }

  const msg = update?.message;
  // Bảng việc chung: trả lời tin việc (chữ hoặc ảnh có chú thích) để ghi chú; /id, /viec cho mọi người trong nhóm.
  if (msg && (await handleTaskReply(msg).catch(() => false))) return Response.json({ ok: true });
  if (!msg?.text) return Response.json({ ok: true });
  const first = String(msg.text).trim().split(/\s+/)[0].toLowerCase();
  if (first === "/id" || first.startsWith("/id@")) {
    await sendTelegram(idReply(msg), { chatId: msg.chat?.id, threadId: Number(msg.message_thread_id) || undefined });
    return Response.json({ ok: true });
  }
  if (first === "/viec" || first.startsWith("/viec@")) {
    await sendTelegram(await myTasksText(msg), { chatId: msg.chat?.id, threadId: Number(msg.message_thread_id) || undefined });
    return Response.json({ ok: true });
  }
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
  // Anh trả lời câu hỏi "Sai vì…" của bot này.
  if (await captureWhy("shopee", msg, shopeeSend).catch(() => false)) return Response.json({ ok: true });
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
    else if (command === "/traloi") await sendTelegram(await replyCommand(String(msg.text).trim().replace(/^\S+\s*/, "")));
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
    parts.push(`\n${esc(shopName(r.shop_id))}: chế độ <b>${r.mode}</b>${r.emergency_stop ? ` — 🛑 ĐANG DỪNG${r.halt_reason ? ` (${esc(r.halt_reason)})` : ""}` : ""}`);
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

const shopeeSend = (text: string, replyMarkup?: unknown) => sendTelegramMessage(text, replyMarkup ? { replyMarkup } : {});

const ACTION_VI: Record<string, string> = {
  change_budget: "đổi ngân sách",
  change_roas_target: "đổi ROAS mục tiêu",
  pause: "tạm dừng",
  resume: "bật lại",
  refresh: "làm mới chiến dịch",
  launch: "lên quảng cáo mã mới",
  set_class: "đổi nhóm hàng",
  group: "nhóm đề xuất",
};

/** Tóm tắt đề xuất quảng cáo Shopee để hỏi "Sai vì…". */
async function actionSummary(id: number): Promise<string> {
  const { data: r } = await db().from("autopilot_actions").select("shop_id, action, campaign_id, reason").eq("id", id).maybeSingle();
  if (!r) return `đề xuất #${id}`;
  let name = "";
  if (r.campaign_id) {
    const { data: c } = await db().from("ads_campaigns").select("ad_name").eq("shop_id", r.shop_id).eq("campaign_id", r.campaign_id).maybeSingle();
    name = c?.ad_name ? ` "${String(c.ad_name).slice(0, 60)}"` : ` #${r.campaign_id}`;
  }
  return `${ACTION_VI[r.action] ?? r.action}${name} (${shopName(r.shop_id)})${r.reason ? `: ${String(r.reason).slice(0, 160)}` : ""}`;
}

async function taskSummary(id: number): Promise<string> {
  const { data: t } = await db().from("shop_tasks").select("shop_id, kind, payload").eq("id", id).maybeSingle();
  if (!t) return `việc #${id}`;
  return t.kind === "reply_low"
    ? `trả lời đánh giá xấu bằng câu soạn sẵn (${shopName(t.shop_id)})`
    : `trả lời cảm ơn ${t.payload?.items?.length ?? ""} đánh giá 4–5 sao (${shopName(t.shop_id)})`;
}
