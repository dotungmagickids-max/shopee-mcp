import { db } from "../supabase";
import {
  backfillCancelInfo,
  collectBalance,
  collectCampaignHourly,
  collectGmsDaily,
  collectShopHourly,
  escrowCandidates,
  refreshCampaigns,
  syncEscrow,
  syncOrders,
  syncOrdersForDay,
} from "./collect";
import { shops, type ShopConf } from "./config";
import { ShopeeCallError } from "./shopee-call";
import { esc, sendAlertOnce, sendTelegram, vnd } from "./telegram";
import { addDays, vnDate, vnDayStartUnix, vnHour } from "./time";
import { dayReport } from "./report";
import { expireOld } from "./actions";
import { evaluateIntraday, proposeCapsForUnlimited, proposeMidnightReset, proposeRoasTargets } from "./rules";
import { proposeRefresh } from "./refresh";
import { proposeLaunches, reviewNewProducts } from "./launch";
import { computeLifecycle } from "./lifecycle";
import { shopMorning } from "./morning";
import { syncPancakeVariations } from "./pancake";
import { computeEconomics } from "./profit";
import { memoryDigestLine } from "../tri-nho";
import { syncReturns } from "./returns";
import { runProfitSteps } from "./steps";

type Step = [name: string, fn: () => Promise<unknown>];

/**
 * Chạy các bước của một job cho một shop, ghi job_runs. Một bước lỗi không chặn bước khác,
 * trừ lỗi xác thực (token): dừng ngay và báo Telegram.
 */
async function runSteps(job: string, shop: ShopConf, steps: Step[]) {
  const { data: run } = await db().from("job_runs").insert({ job, shop_id: shop.shopId }).select("id").single();
  const stats: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, fn] of steps) {
    try {
      stats[name] = await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${name}: ${msg}`);
      if (err instanceof ShopeeCallError && err.kind === "auth") break;
    }
  }
  const ok = errors.length === 0;
  if (run) {
    await db()
      .from("job_runs")
      .update({ finished_at: new Date().toISOString(), ok, error: ok ? null : errors.join("\n").slice(0, 4000), stats })
      .eq("id", run.id);
  }
  if (!ok) {
    await sendAlertOnce(
      `job:${job}:${shop.shopId}`,
      `⚠️ <b>Job ${esc(job)} lỗi</b> — ${esc(shop.name)} (${shop.shopId})\n<code>${esc(errors.join("\n").slice(0, 1500))}</code>\nTool sẽ không tự chỉnh quảng cáo cho tới khi hết lỗi.`,
      60
    );
  }
  return { shop_id: shop.shopId, run_id: (run?.id ?? null) as number | null, ok, errors, stats };
}

// ---------------------------------------------------------------------------
// Job 15 phút
// ---------------------------------------------------------------------------

export async function collectJob(fast = false) {
  const today = vnDate();
  const hour = vnHour();
  const results = [];
  for (const shop of shops()) {
    // Quét nhanh (5 phút, giờ cao điểm): chỉ lấy số theo giờ của chiến dịch rồi chạy luật.
    const steps: Step[] = fast ? [["campaign_hourly", () => collectCampaignHourly(shop.shopId, today)]] : [
      ["campaigns", () => refreshCampaigns(shop.shopId)],
      ["campaign_hourly", () => collectCampaignHourly(shop.shopId, today)],
      ["shop_hourly", () => collectShopHourly(shop.shopId, today)],
      ["balance", () => collectBalance(shop.shopId)],
      ["orders_today", () => syncOrdersForDay(shop.shopId, today)],
    ];
    // Đầu ngày: chốt nốt giờ cuối của hôm qua.
    if (hour === 0 && !fast) {
      const y = addDays(today, -1);
      steps.push(["campaign_hourly_yesterday", () => collectCampaignHourly(shop.shopId, y)]);
      steps.push(["shop_hourly_yesterday", () => collectShopHourly(shop.shopId, y)]);
      steps.push(["orders_yesterday", () => syncOrdersForDay(shop.shopId, y)]);
    }
    if (!fast) steps.push(["alerts", () => checkAlerts(shop)]);
    const res = await runSteps(fast ? "collect_fast" : "collect", shop, steps);
    // Luật chỉ chạy khi số liệu vừa thu đầy đủ: thiếu số liệu thì không chỉnh.
    if (res.ok) {
      try {
        const rules = await evaluateIntraday(shop.shopId);
        (res.stats as Record<string, unknown>).rules = rules;
        if (res.run_id) await db().from("job_runs").update({ stats: res.stats }).eq("id", res.run_id);
      } catch (err) {
        await sendAlertOnce(`rules:${shop.shopId}`, `⚠️ Luật autopilot lỗi — ${esc(shop.name)}: <code>${esc(String(err)).slice(0, 500)}</code>`, 60);
      }
    }
    results.push(res);
  }
  await expireOld().catch(() => 0);
  return results;
}

// ---------------------------------------------------------------------------
// Reset 0h, ROAS mục tiêu hằng ngày, nạp bù lịch sử
// ---------------------------------------------------------------------------

export async function resetJob() {
  const results = [];
  for (const shop of shops()) {
    results.push(await runSteps("reset", shop, [["reset", () => proposeMidnightReset(shop.shopId)]]));
  }
  return results;
}

/** Rà chiến dịch cần làm mới (7h sáng thứ Hai). */
export async function refreshJob() {
  const results = [];
  for (const shop of shops()) {
    results.push(await runSteps("refresh", shop, [["refresh", () => proposeRefresh(shop.shopId)]]));
  }
  return results;
}

/** Thứ Hai 6h40: chấm vòng đời mọi sản phẩm (trang /admin/lifecycle). */
export async function lifecycleJob() {
  const results = [];
  for (const shop of shops()) {
    results.push(await runSteps("lifecycle", shop, [["lifecycle", () => computeLifecycle(shop.shopId)]]));
  }
  return results;
}

/** Thứ Hai 7h10: đề xuất lên quảng cáo mã chưa chạy + đánh giá hàng Mới đủ 14 ngày. */
export async function launchJob() {
  const results = [];
  for (const shop of shops()) {
    results.push(
      await runSteps("launch", shop, [
        ["launch", () => proposeLaunches(shop.shopId)],
        ["new_review", () => reviewNewProducts(shop.shopId)],
      ])
    );
  }
  return results;
}

/** Đề xuất hạn mức cho chiến dịch không giới hạn (chạy tay hoặc từ dashboard). */
export async function capsJob() {
  const results = [];
  for (const shop of shops()) {
    results.push(await runSteps("caps", shop, [["caps", () => proposeCapsForUnlimited(shop.shopId)]]));
  }
  return results;
}

/** Nạp bù một ngày: QC toàn shop theo giờ + đơn hàng (đủ chi tiết). */
export async function backfillJob(date: string) {
  const results = [];
  for (const shop of shops()) {
    results.push(
      await runSteps("backfill", shop, [
        ["shop_hourly", () => collectShopHourly(shop.shopId, date)],
        ["campaign_hourly", async () => collectCampaignHourly(shop.shopId, date, await campaignsOnDate(shop.shopId, date))],
        ["orders", () => syncOrders(shop.shopId, "create_time", vnDayStartUnix(date), vnDayStartUnix(addDays(date, 1)) - 1, 3000)],
      ])
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Job hằng ngày (01:00). Chia 3 phần để mỗi lần gọi nằm trong giới hạn thời gian.
// ---------------------------------------------------------------------------

export async function dailyJob(part: "ads" | "orders" | "escrow" | "costs" | "roas" | "steps") {
  const yesterday = addDays(vnDate(), -1);
  const results = [];
  for (const [i, shop] of shops().entries()) {
    const steps: Step[] = [];
    if (part === "costs") {
      // Giá vốn Pancake dùng chung cho mọi shop: đồng bộ một lần, rồi tính kinh tế từng shop.
      if (i === 0) steps.push(["pancake", () => syncPancakeVariations()]);
      steps.push(["returns", () => syncReturns(shop.shopId)]);
      steps.push(["cancel_info", () => backfillCancelInfo(shop.shopId)]);
      steps.push(["economics", () => computeEconomics(shop.shopId)]);
    } else if (part === "ads") {
      steps.push(["campaigns", () => refreshCampaigns(shop.shopId, 0)]);
      // Ghi nhận đơn kéo dài 7 ngày: lấy lại 7 ngày gần nhất để ROAS lịch sử được cập nhật.
      for (let d = 1; d <= 7; d++) {
        const date = addDays(vnDate(), -d);
        steps.push([`shop_hourly_${date}`, () => collectShopHourly(shop.shopId, date)]);
        steps.push([`campaign_hourly_${date}`, async () => collectCampaignHourly(shop.shopId, date, await campaignsOnDate(shop.shopId, date))]);
      }
      steps.push(["gms_daily", () => collectGmsDaily(shop.shopId, yesterday)]);
    } else if (part === "orders") {
      steps.push(["orders_yesterday", () => syncOrdersForDay(shop.shopId, yesterday)]);
      const now = Math.floor(Date.now() / 1000);
      steps.push(["orders_status_3d", () => syncOrders(shop.shopId, "update_time", now - 3 * 86400, now, 500)]);
    } else if (part === "roas") {
      steps.push(["roas_targets", () => proposeRoasTargets(shop.shopId)]);
    } else if (part === "steps") {
      // 01:30: thử bậc lãi (cải tiến liên tục) — chấm bậc đang thử, mở bậc mới.
      steps.push(["profit_steps", () => runProfitSteps(shop.shopId)]);
    } else {
      steps.push(["escrow", async () => syncEscrow(shop.shopId, await escrowCandidates(shop.shopId))]);
    }
    results.push(await runSteps(`daily_${part}`, shop, steps));
  }
  return results;
}

/** Chiến dịch đang chạy + chiến dịch đã có số liệu ngày đó (có thể đã dừng sau đó). */
async function campaignsOnDate(shopId: number, date: string): Promise<number[]> {
  const ids = new Set<number>();
  const { data: active } = await db()
    .from("ads_campaigns")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  for (const r of active ?? []) ids.add(Number(r.campaign_id));
  const { data: had } = await db()
    .from("ads_campaign_hourly")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .eq("date", date)
    .gt("impression", 0);
  for (const r of had ?? []) ids.add(Number(r.campaign_id));
  return [...ids];
}

// ---------------------------------------------------------------------------
// Cảnh báo
// ---------------------------------------------------------------------------

export async function checkAlerts(shop: ShopConf) {
  const today = vnDate();
  const hour = vnHour();
  const out: Record<string, unknown> = {};

  // 1. Số dư ví sắp hết: dự báo theo tốc độ tiêu.
  const { data: snaps } = await db()
    .from("ads_balance_snapshots")
    .select("total_balance, created_at")
    .eq("shop_id", shop.shopId)
    .gte("created_at", new Date(Date.now() - 80 * 60_000).toISOString())
    .order("created_at", { ascending: true });
  const { data: hours } = await db()
    .from("ads_shop_hourly")
    .select("hour, expense")
    .eq("shop_id", shop.shopId)
    .eq("date", today);
  const expenseByHour = new Map((hours ?? []).map((h) => [h.hour, Number(h.expense)]));
  const lastFullHour = hour > 0 ? expenseByHour.get(hour - 1) ?? 0 : 0;
  let burnPerHour = lastFullHour;
  if (snaps && snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const hrs = (Date.parse(last.created_at) - Date.parse(first.created_at)) / 3_600_000;
    const drop = Number(first.total_balance) - Number(last.total_balance);
    if (hrs >= 0.4 && drop > 0) burnPerHour = Math.max(burnPerHour, drop / hrs);
  }
  const balance = snaps?.length ? Number(snaps[snaps.length - 1].total_balance) : null;
  if (balance != null && burnPerHour > 0) {
    const hoursLeft = balance / burnPerHour;
    out.hours_left = Math.round(hoursLeft * 10) / 10;
    if (hoursLeft < 3) {
      await sendAlertOnce(
        `balance:${shop.shopId}`,
        `💸 <b>Ví quảng cáo sắp hết</b> — ${esc(shop.name)}\nSố dư: <b>${vnd(balance)}</b>\nĐang tiêu ~${vnd(burnPerHour)}/giờ → hết sau khoảng <b>${hoursLeft.toFixed(1)} giờ</b>.\n(Tool không tự nạp tiền.)`,
        90
      );
    }
  }

  // 2. Chi vượt trần ngày (nếu đã cấu hình).
  const { data: settings } = await db()
    .from("autopilot_settings")
    .select("daily_cap_normal")
    .eq("shop_id", shop.shopId)
    .maybeSingle();
  const spent = [...expenseByHour.values()].reduce((a, b) => a + b, 0);
  out.spent_today = spent;
  const cap = settings?.daily_cap_normal ? Number(settings.daily_cap_normal) : null;
  if (cap && spent > cap) {
    await sendAlertOnce(
      `overcap:${shop.shopId}:${today}`,
      `🚨 <b>Chi quảng cáo vượt trần ngày</b> — ${esc(shop.name)}\nĐã chi ${vnd(spent)} / trần ${vnd(cap)}.`,
      24 * 60
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Báo cáo sáng 8h
// ---------------------------------------------------------------------------

export async function morningReportJob() {
  const yesterday = addDays(vnDate(), -1);
  const parts: string[] = [`☀️ <b>Báo cáo sáng · số ngày ${yesterday.split("-").reverse().join("/")}</b>`];
  for (const shop of shops()) {
    try {
      parts.push((await shopMorning(shop)).join("\n"));
    } catch (err) {
      parts.push(`\n<b>${esc(shop.name)}</b>: lỗi lập báo cáo — <code>${esc(String(err)).slice(0, 300)}</code>`);
    }
  }
  const dash = process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  const memory = await memoryDigestLine();
  if (memory) parts.push(memory);
  if (dash) parts.push(`\n<a href="${dash}/admin">Mở dashboard</a>`);
  const text = parts.join("\n");
  const sent = await sendTelegram(text);
  return { sent, text };
}
