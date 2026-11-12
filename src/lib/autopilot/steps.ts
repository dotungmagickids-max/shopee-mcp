import { allRows, db } from "../supabase";
import { proposeGroup } from "./actions";
import { levelTarget, profitTarget, stepsClass, type ProductClass } from "./classes";
import { behindRevenue, daysBetween, monthPace } from "./goals";
import type { Econ } from "./profit";
import { INVALID_STATUSES, ordersBetween } from "./report";
import { automationBlocked, isPeakDay, loadSettings, saleTier, type RuleParams, type ShopSettings } from "./settings";
import { esc, vnd } from "./telegram";
import { addDays, vnDate, vnDayStartUnix } from "./time";

/**
 * Thử bậc lãi — cải tiến liên tục (anh chốt 13/11/2026): không cố định "lãi 10%".
 *
 * Mỗi chiến dịch Chủ lực / Thường có một bậc lãi mong muốn (mặc định theo nhóm). Tool lần lượt thử dời bậc
 * lên hoặc xuống một nấc (ROAS mục tiêu đổi khoảng 12%), chạy vài ngày thường, rồi so TIỀN LÃI/NGÀY của
 * sản phẩm (mọi đơn Shopee của sản phẩm, gồm cả đơn tự nhiên — không dùng số Shopee ghi cho quảng cáo)
 * với các ngày nền trước đó. Số được hiệu chỉnh theo sức mua chung của shop (các sản phẩm khác) để
 * ngày shop đông / vắng không làm sai kết luận.
 *   Lãi/ngày tăng rõ  → giữ bậc mới, lần sau thử tiếp cùng hướng.
 *   Lãi/ngày giảm rõ  → quay lại bậc cũ, lần sau thử hướng ngược.
 *   Ngang nhau        → thiếu doanh số tháng thì giữ bậc bán nhiều hơn, đủ thì giữ bậc lãi % cao hơn.
 * Chỉ báo kết quả (báo cáo sáng), không chờ duyệt. Rào chắn: bậc trong [steps_min_pct, steps_max_pct],
 * tối đa steps_max_running chiến dịch cùng lúc, không thử khi sắp có sale, lãi tháng dưới mục tiêu thì không thử hạ.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const r1 = (x: number) => Math.round(x * 10) / 10;

export type Dir = "down" | "up";

export interface DayStat {
  profit: number;
  revenue: number;
  expense: number;
  control: number; // doanh số các sản phẩm khác của shop (đo sức mua chung)
}

export interface Avg extends DayStat {
  days: string[];
}

export function average(days: string[], stat: (d: string) => DayStat): Avg {
  const out: Avg = { profit: 0, revenue: 0, expense: 0, control: 0, days };
  if (!days.length) return out;
  for (const d of days) {
    const x = stat(d);
    out.profit += x.profit;
    out.revenue += x.revenue;
    out.expense += x.expense;
    out.control += x.control;
  }
  for (const k of ["profit", "revenue", "expense", "control"] as const) out[k] = Math.round(out[k] / days.length);
  return out;
}

/** Ngày dùng để đo: ngày thường (không sale lớn, không trước sale, không sale nhỏ). */
export function measurable(s: ShopSettings, date: string): boolean {
  return saleTier(s, date) === "thuong";
}

/** Lãi mong muốn mặc định của nhóm (khi chưa có bậc riêng). */
export function defaultLevel(cls: ProductClass, p: RuleParams): number {
  return cls === "chu_luc" ? p.scale_core_profit_pct : p.profit_target_pct;
}

/** Bậc kế tiếp theo hướng: ROAS mục tiêu đổi khoảng steps_roas_pct%. null = chạm biên. */
export function nextLevel(e: Econ, level: number, dir: Dir, p: RuleParams): number | null {
  const cur = profitTarget(e, level, "").target;
  if (!cur) return null;
  const fee = 1 + (e.ad_fee_pct ?? 0) / 100;
  const k = (1 - e.cancel_rate) * (1 - e.return_rate);
  const wanted = cur * (dir === "down" ? 1 - p.steps_roas_pct / 100 : 1 + p.steps_roas_pct / 100);
  let pct = ((e.margin - fee / wanted) / k) * 100;
  pct = Math.round(pct * 2) / 2;
  if (dir === "down" && pct > level - 1) pct = level - 1;
  if (dir === "up" && pct < level + 1) pct = level + 1;
  if (pct < p.steps_min_pct || pct > p.steps_max_pct) return null;
  // Bậc lãi phải còn tính được ROAS (lãi mong muốn thấp hơn lãi trước QC).
  if (!profitTarget(e, pct, "").target) return null;
  return pct;
}

export interface Verdict {
  status: "kept" | "reverted";
  gain: number; // % thay đổi lãi/ngày (đã hiệu chỉnh sức mua)
  ctrl: number;
  adjProfit: number;
  adjRevenue: number;
  why: string;
  next_dir: Dir;
}

/** Chấm một bậc: so lãi/ngày đã hiệu chỉnh của các ngày thử với ngày nền. */
export function judge(dir: Dir, base: Avg, test: Avg, gainPct: number, behind: boolean): Verdict {
  const ctrlRaw = base.control > 0 && test.control > 0 ? test.control / base.control : 1;
  const ctrl = Math.min(1.4, Math.max(0.7, ctrlRaw));
  const adjProfit = Math.round(test.profit / ctrl);
  const adjRevenue = Math.round(test.revenue / ctrl);
  const gain = (100 * (adjProfit - base.profit)) / Math.max(Math.abs(base.profit), 50_000);
  const flip: Dir = dir === "down" ? "up" : "down";
  const money = `lãi ${vnd(base.profit)} → ${vnd(adjProfit)}/ngày`;
  if (gain >= gainPct) return { status: "kept", gain, ctrl, adjProfit, adjRevenue, next_dir: dir, why: `${money} (+${Math.round(gain)}%)` };
  if (gain <= -gainPct) return { status: "reverted", gain, ctrl, adjProfit, adjRevenue, next_dir: flip, why: `${money} (${Math.round(gain)}%)` };
  // Ngang nhau: thiếu doanh số tháng → giữ bậc bán nhiều hơn (bậc thấp); đủ → giữ bậc lãi % cao hơn.
  const keep = dir === "down" ? behind && adjRevenue > base.revenue : !behind;
  return {
    status: keep ? "kept" : "reverted",
    gain,
    ctrl,
    adjProfit,
    adjRevenue,
    next_dir: keep ? dir : flip,
    why: `${money} (ngang nhau) — ${
      behind ? "đang thiếu doanh số tháng nên ưu tiên bậc bán nhiều hơn" : "đủ tiến độ doanh số nên ưu tiên bậc lãi % cao hơn, ít tiền QC hơn"
    }`,
  };
}

interface StepRow {
  id: number;
  campaign_id: number;
  cls: string | null;
  direction: Dir;
  from_pct: number;
  to_pct: number;
  from_roas: number | null;
  to_roas: number | null;
  status: string;
  started_on: string;
  decided_on: string | null;
  base: Avg | null;
  result: any;
}

export async function runProfitSteps(shopId: number) {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const p = s.params;
  if (!p.steps_enabled) return { skipped: "Thử bậc đang tắt" };
  const today = vnDate();
  const yesterday = addDays(today, -1);
  const fee = 1 + p.ad_fee_pct / 100;

  const { data: campRows, error } = await db()
    .from("ads_campaigns")
    .select("*")
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing")
    .eq("autopilot_excluded", false);
  if (error) throw new Error(error.message);
  const camps = (campRows ?? []).map((c: any) => ({
    campaign_id: Number(c.campaign_id),
    ad_name: String(c.ad_name ?? ""),
    item_ids: (c.item_ids ?? []).map(Number) as number[],
    roas_target: c.roas_target == null ? null : n(c.roas_target),
    level: c.profit_level_pct == null ? null : n(c.profit_level_pct),
    econ: (c.econ ?? null) as Econ | null,
  }));
  const byId = new Map(camps.map((c) => [c.campaign_id, c]));

  const { data: stepData } = await db()
    .from("profit_steps")
    .select("*")
    .eq("shop_id", shopId)
    .gte("started_on", addDays(today, -60))
    .order("started_on", { ascending: false });
  const steps = (stepData ?? []).map((x: any) => ({ ...x, campaign_id: Number(x.campaign_id), from_pct: n(x.from_pct), to_pct: n(x.to_pct) })) as StepRow[];

  // Số liệu 35 ngày: chi QC theo chiến dịch, doanh số theo sản phẩm (mọi đơn Shopee), doanh số cả shop.
  const from = addDays(today, -35);
  const daily = await allRows(() =>
    db()
      .from("ads_campaign_daily")
      .select("campaign_id, date, expense")
      .eq("shop_id", shopId)
      .gte("date", from)
      .lte("date", yesterday)
      .order("campaign_id")
      .order("date")
  );
  const exp = new Map<string, number>();
  for (const r of daily) exp.set(`${r.campaign_id}|${r.date}`, n(r.expense));
  const orders = await ordersBetween(shopId, vnDayStartUnix(from), vnDayStartUnix(today));
  const itemRev = new Map<string, number>();
  const shopRev = new Map<string, number>();
  for (const o of orders) {
    if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
    const d = vnDate(new Date(o.create_time * 1000));
    for (const it of (o.items ?? []) as any[]) {
      const v = n(it.price) * n(it.qty ?? 1);
      if (!v) continue;
      const k = `${it.item_id}|${d}`;
      itemRev.set(k, (itemRev.get(k) ?? 0) + v);
      shopRev.set(d, (shopRev.get(d) ?? 0) + v);
    }
  }
  const statOf = (c: (typeof camps)[number]) => (d: string): DayStat => {
    const revenue = c.item_ids.reduce((t, id) => t + (itemRev.get(`${id}|${d}`) ?? 0), 0);
    const expense = exp.get(`${c.campaign_id}|${d}`) ?? 0;
    return {
      revenue,
      expense,
      profit: revenue * (c.econ?.margin ?? 0) - expense * fee,
      control: (shopRev.get(d) ?? 0) - revenue,
    };
  };
  const normalDays = (after: string, upto: string) => {
    const out: string[] = [];
    for (let d = addDays(after, 1); d <= upto; d = addDays(d, 1)) if (measurable(s, d)) out.push(d);
    return out;
  };

  const pace = await monthPace(shopId, s, today).catch(() => null);
  const behind = behindRevenue(pace);
  const roasItems: { campaign_id: number; action: "change_roas_target"; before: any; after: any }[] = [];
  const decided: string[] = [];

  /** Đặt bậc lãi cho chiến dịch: lưu bậc, cập nhật ngưỡng ngay, đổi ROAS mục tiêu Shopee (≤ ±roas_max_change_pct). */
  const applyLevel = async (c: (typeof camps)[number], level: number, why: string) => {
    const e = c.econ!;
    const cls = (e.class ?? "thuong") as ProductClass;
    const t = levelTarget(e, cls, level);
    await db()
      .from("ads_campaigns")
      .update({ profit_level_pct: level, econ: { ...e, target: t.target, target_label: t.label, level_pct: level } })
      .eq("shop_id", shopId)
      .eq("campaign_id", c.campaign_id);
    c.level = level;
    if (t.target && c.roas_target) {
      const max = p.roas_max_change_pct / 100;
      const next = r1(Math.min(c.roas_target * (1 + max), Math.max(c.roas_target * (1 - max), t.target)));
      if (next !== c.roas_target) {
        roasItems.push({ campaign_id: c.campaign_id, action: "change_roas_target", before: { roas_target: c.roas_target }, after: { roas_target: next, why } });
      }
    }
    return t.target;
  };

  // ---- 1. Chấm các bậc đang thử ----
  const running = steps.filter((x) => x.status === "running");
  for (const st of running) {
    const c = byId.get(st.campaign_id);
    const close = async (status: "kept" | "reverted" | "stopped", result: any, note: string) => {
      await db().from("profit_steps").update({ status, decided_on: today, result, note }).eq("id", st.id);
      st.status = status;
      st.decided_on = today;
      st.result = result;
    };
    if (!c || !c.econ?.margin || !stepsClass(c.econ.class)) {
      if (c) await db().from("ads_campaigns").update({ profit_level_pct: null }).eq("shop_id", shopId).eq("campaign_id", c.campaign_id);
      await close("stopped", { next_dir: st.direction }, c ? "Không còn là Chủ lực / Thường" : "Chiến dịch đã dừng");
      continue;
    }
    const testDays = normalDays(st.started_on, yesterday);
    const age = daysBetween(st.started_on, today);
    const base = st.base;
    if (!base || !base.days?.length) {
      await close("stopped", { next_dir: st.direction }, "Thiếu số ngày nền");
      continue;
    }
    if (testDays.length < p.steps_test_days && age < p.steps_max_days) {
      // Dừng sớm: thử hạ mà lỗ rõ (lãi/ngày âm, kém nền > 3 lần ngưỡng) sau ≥ 2 ngày.
      if (testDays.length >= 2) {
        const v = judge(st.direction, base, average(testDays, statOf(c)), p.steps_gain_pct, behind);
        if (v.adjProfit < 0 && v.gain <= -3 * p.steps_gain_pct) {
          await applyLevel(c, st.from_pct, `Thử bậc: quay lại lãi ${st.from_pct}% sớm (${v.why})`);
          await close("reverted", { ...average(testDays, statOf(c)), ...v, early: true }, `Dừng sớm: ${v.why}`);
          decided.push(c.ad_name);
        }
      }
      continue;
    }
    if (testDays.length < 2) {
      await applyLevel(c, st.from_pct, `Thử bậc: quay lại lãi ${st.from_pct}% (không đủ ngày thường để đo)`);
      await close("stopped", { next_dir: st.direction }, "Không đủ ngày thường để đo (nhiều ngày sale)");
      continue;
    }
    const test = average(testDays, statOf(c));
    const v = judge(st.direction, base, test, p.steps_gain_pct, behind);
    if (v.status === "reverted") await applyLevel(c, st.from_pct, `Thử bậc: quay lại lãi ${st.from_pct}% — ${v.why}`);
    await close(v.status, { ...test, ...v }, v.why);
    decided.push(c.ad_name);
  }

  // ---- 2. Mở bậc mới ----
  const stillRunning = steps.filter((x) => x.status === "running").length;
  let slots = p.steps_max_running - stillRunning;
  const saleSoon = [0, 1, 2].some((k) => isPeakDay(s, addDays(today, k)));
  const started: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  if (slots > 0 && !saleSoon) {
    // Ngày đổi ROAS mục tiêu gần nhất (mọi nguồn): ngày nền phải sau ngày đó.
    const { data: changes } = await db()
      .from("autopilot_actions")
      .select("campaign_id, created_at")
      .eq("shop_id", shopId)
      .eq("action", "change_roas_target")
      .in("status", ["executed", "dry_run"])
      .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString());
    const lastChange = new Map<number, string>();
    for (const r of changes ?? []) {
      const d = vnDate(new Date(r.created_at));
      const id = Number(r.campaign_id);
      if (!lastChange.has(id) || lastChange.get(id)! < d) lastChange.set(id, d);
    }
    const profitLow = pace?.profitPct != null && pace.profitPct < pace.goalPct;
    const cands: { c: (typeof camps)[number]; base: Avg; dir: Dir; from: number; to: number }[] = [];
    for (const c of camps) {
      const e = c.econ;
      if (!e?.margin || !stepsClass(e.class) || e.source !== "item") continue;
      if (steps.some((x) => x.campaign_id === c.campaign_id && x.status === "running")) continue;
      if (!e.target || !c.roas_target || Math.abs(c.roas_target / e.target - 1) > 0.1) {
        skip("ROAS mục tiêu Shopee chưa về đúng mức");
        continue;
      }
      const last = steps.find((x) => x.campaign_id === c.campaign_id);
      const since = [last?.decided_on, lastChange.get(c.campaign_id), addDays(today, -36)].filter(Boolean).sort().pop()!;
      const days = normalDays(since, yesterday).slice(-p.steps_base_days);
      if (days.length < p.steps_min_base_days) {
        skip("chưa đủ ngày nền ở mức hiện tại");
        continue;
      }
      const base = average(days, statOf(c));
      if (base.expense < p.steps_min_daily_spend) {
        skip("chi quá ít để đo");
        continue;
      }
      const cls = (e.class ?? "thuong") as ProductClass;
      const level = c.level ?? defaultLevel(cls, p);
      let dir: Dir = (last?.result?.next_dir as Dir) ?? (behind ? "down" : "up");
      if (profitLow) dir = "up"; // lãi tháng dưới mục tiêu: không thử hạ lãi
      let to = nextLevel(e, level, dir, p);
      if (to == null && !profitLow) {
        dir = dir === "down" ? "up" : "down";
        to = nextLevel(e, level, dir, p);
      }
      if (to == null) {
        skip("đã ở biên bậc lãi");
        continue;
      }
      cands.push({ c, base, dir, from: level, to });
    }
    cands.sort((a, b) => b.base.expense - a.base.expense);
    for (const k of cands) {
      if (slots <= 0) break;
      const e = k.c.econ!;
      const fromRoas = profitTarget(e, k.from, "").target;
      const why = `Thử bậc: lãi ${k.from}% → ${k.to}% (${k.dir === "down" ? "bán nhiều hơn" : "lãi % cao hơn"}), đo ${p.steps_test_days} ngày thường`;
      const toRoas = await applyLevel(k.c, k.to, why);
      await db().from("profit_steps").insert({
        shop_id: shopId,
        campaign_id: k.c.campaign_id,
        cls: e.class,
        direction: k.dir,
        from_pct: k.from,
        to_pct: k.to,
        from_roas: fromRoas,
        to_roas: toRoas,
        started_on: today,
        base: k.base,
      });
      started.push(k.c.ad_name);
      slots--;
    }
  }

  if (roasItems.length) {
    await proposeGroup(
      shopId,
      `Thử bậc lãi: đổi ROAS mục tiêu ${roasItems.length} chiến dịch`,
      roasItems,
      "rule:step",
      "Cải tiến liên tục: thử bậc lãi mới hoặc quay lại bậc cũ theo kết quả đo tiền lãi/ngày. Tự chạy, báo trong báo cáo sáng.",
      12 * 60,
      { autoExecute: true }
    );
  }
  return {
    decided: decided.length,
    started: started.length,
    running: stillRunning + started.length,
    roas_changes: roasItems.length,
    sale_soon: saleSoon,
    behind_revenue: behind,
    skipped,
  };
}

/** Báo cáo thử bậc: kết luận trong `days` ngày qua + số đang thử. Rỗng nếu chưa có gì. */
export async function stepsLines(shopId: number, days: number): Promise<string[]> {
  const today = vnDate();
  const { data } = await db()
    .from("profit_steps")
    .select("*")
    .eq("shop_id", shopId)
    .or(`status.eq.running,decided_on.gte.${addDays(today, -days + 1)},started_on.gte.${addDays(today, -days + 1)}`)
    .order("decided_on", { ascending: false });
  const rows = (data ?? []) as StepRow[];
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => Number(r.campaign_id)))];
  const { data: names } = await db().from("ads_campaigns").select("campaign_id, ad_name").eq("shop_id", shopId).in("campaign_id", ids);
  const nameOf = new Map((names ?? []).map((x: any) => [Number(x.campaign_id), String(x.ad_name ?? "")]));
  const nm = (id: number) => esc((nameOf.get(Number(id)) ?? `#${id}`).slice(0, 34));
  const done = rows.filter((r) => r.status !== "running" && r.decided_on && r.decided_on >= addDays(today, -days + 1));
  const run = rows.filter((r) => r.status === "running");
  const fresh = run.filter((r) => r.started_on >= addDays(today, -days + 1));
  const out: string[] = [`\n🔬 <b>THỬ BẬC LÃI</b> (cải tiến liên tục)`];
  const mark = { kept: "✅ giữ", reverted: "↩️ quay lại", stopped: "⏹ dừng" } as Record<string, string>;
  let gain = 0;
  for (const r of done) {
    const target = r.status === "kept" ? r.to_pct : r.from_pct;
    out.push(`• ${mark[r.status] ?? r.status} ${nm(r.campaign_id)}: thử ${r.from_pct}% → ${r.to_pct}%, chốt <b>lãi ${target}%</b> — ${esc(String(r.result?.why ?? r.status))}`);
    if (r.status === "kept" && r.result?.adjProfit != null && r.base) gain += n(r.result.adjProfit) - n(r.base.profit);
  }
  if (gain > 0) out.push(`• Ước thêm <b>${vnd(Math.round(gain))}</b> lãi/ngày từ các bậc đã giữ`);
  for (const r of fresh) {
    out.push(`• Bắt đầu thử ${nm(r.campaign_id)}: lãi ${r.from_pct}% → ${r.to_pct}% (ROAS ${r.from_roas ?? "-"} → ${r.to_roas ?? "-"})`);
  }
  const older = run.length - fresh.length;
  if (older > 0) out.push(`• Đang đo: ${older} chiến dịch`);
  if (out.length === 1) return [];
  return out;
}
