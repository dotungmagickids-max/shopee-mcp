import { db } from "../supabase";
import type { Econ, EconSummary } from "./profit";
import { INVALID_STATUSES } from "./report";
import { addDays, vnDate, vnDayStartUnix, vnHourOfUnix, vnWeekday, weekdayOfDate } from "./time";

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Đọc hết các trang (PostgREST trả tối đa 1000 dòng mỗi lần). */
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let page = 0; page < 100; page++) {
    const { data, error } = await build(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export interface HourRow {
  hour: number;
  expense: number;
  gmv: number;
  adOrders: number;
  clicks: number;
  orders: number;
}

export async function todayOverview(shopId: number) {
  const date = vnDate();
  const { data: hours } = await db()
    .from("ads_shop_hourly")
    .select("hour, expense, broad_gmv, broad_order, clicks")
    .eq("shop_id", shopId)
    .eq("date", date)
    .order("hour");
  const orders = await all<{ create_time: number; order_status: string | null; total_amount: number | null }>((f, t) =>
    db()
      .from("orders")
      .select("create_time, order_status, total_amount")
      .eq("shop_id", shopId)
      .gte("create_time", vnDayStartUnix(date))
      .range(f, t)
  );
  const valid = orders.filter((o) => !INVALID_STATUSES.includes(o.order_status ?? ""));
  const byHour: HourRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, expense: 0, gmv: 0, adOrders: 0, clicks: 0, orders: 0 }));
  for (const h of hours ?? []) {
    const r = byHour[h.hour];
    r.expense = n(h.expense);
    r.gmv = n(h.broad_gmv);
    r.adOrders = n(h.broad_order);
    r.clicks = n(h.clicks);
  }
  for (const o of valid) byHour[vnHourOfUnix(o.create_time)].orders++;

  const { data: bal } = await db()
    .from("ads_balance_snapshots")
    .select("total_balance, created_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: lastRun } = await db()
    .from("job_runs")
    .select("job, started_at, finished_at, ok, error, stats")
    .eq("shop_id", shopId)
    .eq("job", "collect")
    .order("started_at", { ascending: false })
    .limit(1);
  const { data: failures } = await db()
    .from("job_runs")
    .select("job, started_at, error")
    .eq("shop_id", shopId)
    .eq("ok", false)
    .gte("started_at", new Date(Date.now() - 24 * 3600_000).toISOString())
    .order("started_at", { ascending: false })
    .limit(5);

  const expense = byHour.reduce((s, h) => s + h.expense, 0);
  const gmv = byHour.reduce((s, h) => s + h.gmv, 0);
  const adOrders = byHour.reduce((s, h) => s + h.adOrders, 0);
  return {
    date,
    byHour,
    expense,
    gmv,
    adOrders,
    roas: expense > 0 ? gmv / expense : 0,
    costPerOrder: adOrders ? expense / adOrders : 0,
    orders: valid.length,
    revenue: valid.reduce((s, o) => s + n(o.total_amount), 0),
    balance: bal?.[0] ? n(bal[0].total_balance) : null,
    balanceAt: bal?.[0]?.created_at ?? null,
    lastRun: lastRun?.[0] ?? null,
    failures: failures ?? [],
  };
}

// ---------------------------------------------------------------------------
// Chiến dịch + xếp hạng
// ---------------------------------------------------------------------------

export interface CampaignRow {
  campaign_id: number;
  ad_name: string | null;
  campaign_status: string | null;
  bidding_method: string | null;
  campaign_budget: number;
  roas_target: number | null;
  item_ids: number[];
  excluded: boolean;
  toolPaused: boolean;
  throttled: boolean;
  today: { expense: number; gmv: number; orders: number; clicks: number };
  week: { expense: number; gmv: number; orders: number; clicks: number; roas: number };
  verdict: "tăng" | "giữ" | "giảm" | "tắt" | "chờ số liệu";
  reason: string;
  econ: Econ | null;
  /** Lãi ước tính 7 ngày D-8…D-2 = GMV × lãi trước QC/1đ GMV − chi QC. */
  weekProfit: number | null;
}

/** Tóm tắt kinh tế shop (phí Shopee thật, hủy/hoàn) do job giá vốn tính hằng đêm. */
export async function econSummary(shopId: number): Promise<EconSummary | null> {
  const { data } = await db().from("autopilot_settings").select("econ_summary").eq("shop_id", shopId).maybeSingle();
  return (data?.econ_summary ?? null) as EconSummary | null;
}

/**
 * ROAS 7 ngày đã bỏ 2 ngày gần nhất (đơn còn được ghi nhận thêm): từ D-8 tới D-2.
 * Ngưỡng: N click không ra đơn → tắt; ROAS thực < 80% mục tiêu → giảm; ≥ 120% → tăng.
 */
export async function campaignsWithRanking(shopId: number, noOrderClicks = 40): Promise<CampaignRow[]> {
  const today = vnDate();
  const { data: camps, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, ad_name, campaign_status, bidding_method, campaign_budget, roas_target, item_ids, autopilot_excluded, tool_paused_at, throttled_at, econ")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"])
    .order("campaign_id", { ascending: false });
  if (error) throw new Error(error.message);
  const ids = (camps ?? []).map((c) => c.campaign_id);
  if (!ids.length) return [];

  const daily = await all<any>((f, t) =>
    db()
      .from("ads_campaign_daily")
      .select("campaign_id, date, expense, broad_gmv, broad_order, clicks")
      .eq("shop_id", shopId)
      .gte("date", addDays(today, -8))
      .in("campaign_id", ids)
      .range(f, t)
  );
  const weekFrom = addDays(today, -8);
  const weekTo = addDays(today, -2);
  const agg = new Map<number, { today: any; week: any }>();
  for (const id of ids) {
    agg.set(Number(id), {
      today: { expense: 0, gmv: 0, orders: 0, clicks: 0 },
      week: { expense: 0, gmv: 0, orders: 0, clicks: 0, roas: 0 },
    });
  }
  for (const d of daily) {
    const a = agg.get(Number(d.campaign_id));
    if (!a) continue;
    const target = d.date === today ? a.today : d.date >= weekFrom && d.date <= weekTo ? a.week : null;
    if (!target) continue;
    target.expense += n(d.expense);
    target.gmv += n(d.broad_gmv);
    target.orders += n(d.broad_order);
    target.clicks += n(d.clicks);
  }

  return (camps ?? []).map((c) => {
    const a = agg.get(Number(c.campaign_id))!;
    a.week.roas = a.week.expense > 0 ? a.week.gmv / a.week.expense : 0;
    const target = c.roas_target != null ? n(c.roas_target) : null;
    let verdict: CampaignRow["verdict"] = "giữ";
    let reason = "";
    if (a.week.expense === 0 && a.week.clicks === 0) {
      verdict = "chờ số liệu";
      reason = "Chưa có chi tiêu trong 7 ngày (D-8…D-2)";
    } else if (a.week.orders === 0 && a.week.clicks >= noOrderClicks) {
      verdict = "tắt";
      reason = `${a.week.clicks} click, 0 đơn trong 7 ngày`;
    } else if (target && a.week.roas < target * 0.8) {
      verdict = "giảm";
      reason = `ROAS 7 ngày ${a.week.roas.toFixed(1)} < 80% mục tiêu ${target}`;
    } else if (target && a.week.roas >= target * 1.2) {
      verdict = "tăng";
      reason = `ROAS 7 ngày ${a.week.roas.toFixed(1)} ≥ 120% mục tiêu ${target}`;
    } else {
      reason = target ? `ROAS 7 ngày ${a.week.roas.toFixed(1)} quanh mục tiêu ${target}` : `ROAS 7 ngày ${a.week.roas.toFixed(1)}`;
    }
    return {
      campaign_id: Number(c.campaign_id),
      ad_name: c.ad_name,
      campaign_status: c.campaign_status,
      bidding_method: c.bidding_method,
      campaign_budget: n(c.campaign_budget),
      roas_target: target,
      item_ids: c.item_ids ?? [],
      excluded: !!c.autopilot_excluded,
      toolPaused: !!c.tool_paused_at,
      throttled: !!c.throttled_at,
      today: a.today,
      week: a.week,
      verdict,
      reason,
      econ: (c.econ ?? null) as Econ | null,
      weekProfit: c.econ && a.week.expense > 0 ? Math.round(a.week.gmv * Number(c.econ.margin) - a.week.expense) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Bản đồ nhiệt giờ × thứ
// ---------------------------------------------------------------------------

export type HeatMetric = "orders" | "expense" | "roas" | "cpo";

/** cells[weekday 0=CN..6][hour] = giá trị trung bình mỗi ngày (ROAS và CPO: tổng/tổng). */
export async function heatmap(shopId: number, weeks: number, metric: HeatMetric) {
  const today = vnDate();
  const from = addDays(today, -weeks * 7);
  const sum = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const expense = sum();
  const gmv = sum();
  const adOrders = sum();
  const orders = sum();
  const daysPerWeekday = Array(7).fill(0);
  for (let d = from; d < today; d = addDays(d, 1)) daysPerWeekday[weekdayOfDate(d)]++;

  if (metric === "orders") {
    const rows = await all<{ create_time: number; order_status: string | null }>((f, t) =>
      db()
        .from("orders")
        .select("create_time, order_status")
        .eq("shop_id", shopId)
        .gte("create_time", vnDayStartUnix(from))
        .lt("create_time", vnDayStartUnix(today))
        .range(f, t)
    );
    for (const o of rows) {
      if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
      orders[vnWeekday(o.create_time)][vnHourOfUnix(o.create_time)]++;
    }
  } else {
    const rows = await all<any>((f, t) =>
      db()
        .from("ads_shop_hourly")
        .select("date, hour, expense, broad_gmv, broad_order")
        .eq("shop_id", shopId)
        .gte("date", from)
        .lt("date", today)
        .range(f, t)
    );
    for (const r of rows) {
      const wd = weekdayOfDate(r.date);
      expense[wd][r.hour] += n(r.expense);
      gmv[wd][r.hour] += n(r.broad_gmv);
      adOrders[wd][r.hour] += n(r.broad_order);
    }
  }

  const cells = sum().map((row, wd) =>
    row.map((_, h) => {
      const days = Math.max(1, daysPerWeekday[wd]);
      if (metric === "orders") return orders[wd][h] / days;
      if (metric === "expense") return expense[wd][h] / days;
      if (metric === "roas") return expense[wd][h] > 0 ? gmv[wd][h] / expense[wd][h] : 0;
      return adOrders[wd][h] > 0 ? expense[wd][h] / adOrders[wd][h] : 0;
    })
  );
  return { from, to: addDays(today, -1), cells };
}

// ---------------------------------------------------------------------------
// Nhật ký
// ---------------------------------------------------------------------------

export async function recentLog(limit = 100) {
  const [actions, runs, audit] = await Promise.all([
    db().from("autopilot_actions").select("*").order("created_at", { ascending: false }).limit(limit),
    db().from("job_runs").select("id, job, shop_id, started_at, finished_at, ok, error").order("started_at", { ascending: false }).limit(limit),
    db()
      .from("audit_log")
      .select("shop_id, endpoint, access, ok, error, created_at")
      .like("endpoint", "autopilot:%")
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);
  return { actions: actions.data ?? [], runs: runs.data ?? [], audit: audit.data ?? [] };
}

/** Kiểm tra "không mất giờ nào": số lần collect thành công theo từng giờ trong 48h. */
export async function collectCoverage(hours = 48) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data } = await db()
    .from("job_runs")
    .select("shop_id, started_at, ok")
    .eq("job", "collect")
    .gte("started_at", since)
    .limit(5000);
  const buckets = new Map<string, number>();
  for (const r of data ?? []) {
    if (!r.ok) continue;
    const key = new Date(r.started_at).toISOString().slice(0, 13);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let missing = 0;
  for (let i = 1; i <= hours; i++) {
    const key = new Date(Date.now() - i * 3600_000).toISOString().slice(0, 13);
    if (!buckets.has(key)) missing++;
  }
  return { hours, missing, runs: data?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Đề xuất đang chờ duyệt
// ---------------------------------------------------------------------------

export async function pendingProposals() {
  const { data } = await db()
    .from("autopilot_actions")
    .select("*")
    .eq("status", "proposed")
    .is("parent_id", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  const rows = data ?? [];
  const groupIds = rows.filter((r) => r.action === "group").map((r) => r.id);
  const children = new Map<number, any[]>();
  if (groupIds.length) {
    const { data: kids } = await db().from("autopilot_actions").select("*").in("parent_id", groupIds).order("id");
    for (const k of kids ?? []) {
      if (!children.has(k.parent_id)) children.set(k.parent_id, []);
      children.get(k.parent_id)!.push(k);
    }
  }
  const ids = new Set<string>();
  for (const r of [...rows, ...[...children.values()].flat()]) if (r.campaign_id) ids.add(`${r.shop_id}:${r.campaign_id}`);
  const names = new Map<string, string>();
  if (ids.size) {
    const { data: camps } = await db()
      .from("ads_campaigns")
      .select("shop_id, campaign_id, ad_name")
      .in("campaign_id", [...ids].map((k) => Number(k.split(":")[1])));
    for (const c of camps ?? []) names.set(`${c.shop_id}:${c.campaign_id}`, c.ad_name ?? "");
  }
  return rows.map((r) => ({
    ...r,
    name: names.get(`${r.shop_id}:${r.campaign_id}`) ?? "",
    children: (children.get(r.id) ?? []).map((k) => ({ ...k, name: names.get(`${k.shop_id}:${k.campaign_id}`) ?? "" })),
  }));
}
