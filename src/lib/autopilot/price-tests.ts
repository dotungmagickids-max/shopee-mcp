import { allRows, db } from "../supabase";
import { behindRevenue, daysBetween, monthPace } from "./goals";
import type { Econ } from "./profit";
import { INVALID_STATUSES, ordersBetween } from "./report";
import { automationBlocked, isPeakDay, loadSettings } from "./settings";
import { callShopee } from "./shopee-call";
import { average, judge, measurable, type Avg, type DayStat, type Dir } from "./steps";
import { esc, vnd } from "./telegram";
import { addDays, vnDate, vnDayStartUnix } from "./time";

/**
 * Thử giá — anh chốt 13/11/2026: tool tự đổi giá khuyến mãi ±5%, tối đa 3 mã cùng lúc, không chờ duyệt;
 * báo đã làm gì và kết quả trong báo cáo 8h.
 *
 * - Chỉ đổi qua chương trình giảm giá của shop (price_test_discount_id): mọi phân loại của mã phải đang nằm trong
 *   chương trình đó (mã đang ở Rẻ Vô Địch / Flash Sale / chương trình khác thì bỏ qua). Giá tăng không vượt giá gốc.
 * - Mỗi mã chỉ một thay đổi một lúc: không thử mã đang thử bậc lãi, chiến dịch có ROAS chưa ổn định thì chưa thử.
 * - Đo như thử bậc: lãi/ngày của sản phẩm trên mọi đơn Shopee (theo giá vốn thật), 4 ngày thường, hiệu chỉnh sức mua.
 *   Lãi tăng → giữ giá mới; giảm → trả giá cũ; ngang → thiếu doanh số thì giữ giá bán nhiều hơn.
 *   Hàng xả kho luôn thử giảm và coi trọng số bán (hạn bán hết).
 * - Trước khi trả giá cũ, đọc lại giá: nếu anh hoặc chương trình khác đã đổi giá thì không đụng vào.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;

export interface ModelPrice {
  model_id: number;
  old: number;
  new: number;
}

/** Giá mới của từng phân loại: đổi đúng tối đa pct%, làm tròn nghìn về phía an toàn (không vượt pct). null = không đổi được. */
export function testPrices(
  models: { model_id: number; current: number; original: number }[],
  dir: Dir,
  pct: number,
  minPrice: number
): ModelPrice[] | null {
  const out: ModelPrice[] = [];
  for (const m of models) {
    const next =
      dir === "up" ? Math.floor((m.current * (1 + pct / 100)) / 1000) * 1000 : Math.ceil((m.current * (1 - pct / 100)) / 1000) * 1000;
    if (next === m.current) return null;
    if (dir === "up" && next >= m.original) return null; // giá khuyến mãi phải thấp hơn giá gốc
    if (dir === "down" && next < minPrice) return null; // không bán dưới giá tối thiểu còn lãi trước QC
    out.push({ model_id: m.model_id, old: m.current, new: next });
  }
  return out.length ? out : null;
}

interface PriceTest {
  id: number;
  item_id: number;
  name: string | null;
  campaign_ids: number[];
  cls: string | null;
  direction: Dir;
  pct: number;
  discount_id: number;
  models: ModelPrice[];
  status: string;
  started_on: string;
  decided_on: string | null;
  base: (Avg & { unit_cost?: number }) | null;
  result: any;
}

async function readModels(shopId: number, itemId: number) {
  const res = await callShopee(shopId, "product.get_model_list", { item_id: itemId });
  return ((res.response?.model ?? []) as any[]).map((x) => ({
    model_id: Number(x.model_id),
    promotion_id: Number(x.promotion_id ?? 0),
    current: n(x.price_info?.[0]?.current_price),
    original: n(x.price_info?.[0]?.original_price),
  }));
}

async function setPrices(shopId: number, discountId: number, itemId: number, prices: { model_id: number; price: number }[]) {
  const res = await callShopee(
    shopId,
    "discount.update_discount_item",
    {
      discount_id: discountId,
      item_list: [{ item_id: itemId, model_list: prices.map((p) => ({ model_id: p.model_id, model_promotion_price: p.price })) }],
    },
    { allowWrite: true }
  );
  const errs = (res.response?.error_list ?? []) as any[];
  if (errs.length) throw new Error(`Shopee từ chối đổi giá: ${JSON.stringify(errs).slice(0, 300)}`);
}

async function logPrice(shopId: number, t: { item_id: number; name: string | null }, from: string, to: string, reason: string) {
  await db().from("autopilot_actions").insert({
    shop_id: shopId,
    campaign_id: null,
    action: "promo_price",
    before: { item_id: t.item_id, price: from },
    after: { item_id: t.item_id, price: to, name: t.name },
    reason,
    source: "rule:price_test",
    status: "executed",
    decided_by: "auto",
    decided_at: new Date().toISOString(),
    executed_at: new Date().toISOString(),
  });
}

const range = (xs: number[]) => {
  const a = Math.min(...xs);
  const b = Math.max(...xs);
  return a === b ? vnd(a) : `${vnd(a)}–${vnd(b)}`;
};

export async function runPriceTests(shopId: number) {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const p = s.params;
  const discountId = n(p.price_test_discount_id);
  if (!p.price_tests_enabled || !discountId) return { skipped: "Thử giá đang tắt" };
  const pct = Math.min(5, Math.max(1, n(p.price_test_pct))); // trần cứng anh chốt: ±5%
  const maxRunning = Math.min(3, Math.max(0, n(p.price_test_max_running))); // trần cứng: 3 mã
  const today = vnDate();
  const yesterday = addDays(today, -1);
  const fee = 1 + p.ad_fee_pct / 100;

  const { data: st } = await db().from("autopilot_settings").select("econ_summary").eq("shop_id", shopId).maybeSingle();
  const shopEcon = (st?.econ_summary?.shop ?? null) as Econ | null;
  if (!shopEcon) return { skipped: "Chưa có số kinh tế shop" };
  // Lãi trên mỗi đồng doanh số (trước giá vốn) và trên mỗi đồng giá vốn, theo tỉ lệ tiền về / hủy / hoàn của shop.
  const keepC = 1 - shopEcon.cancel_rate;
  const k1 = keepC * (shopEcon.payout * (1 - shopEcon.return_rate) - (shopEcon.return_fee_ratio ?? 0));
  const k2 = keepC * (1 - shopEcon.return_back_rate);

  const { data: testRows } = await db()
    .from("price_tests")
    .select("*")
    .eq("shop_id", shopId)
    .gte("started_on", addDays(today, -90))
    .order("started_on", { ascending: false });
  const tests = (testRows ?? []).map((x: any) => ({ ...x, item_id: Number(x.item_id), campaign_ids: (x.campaign_ids ?? []).map(Number) })) as PriceTest[];

  // Số liệu 35 ngày: doanh số + số cái theo sản phẩm (mọi đơn), doanh số cả shop, chi QC theo chiến dịch.
  const from = addDays(today, -35);
  const orders = await ordersBetween(shopId, vnDayStartUnix(from), vnDayStartUnix(today));
  const rev = new Map<string, number>();
  const units = new Map<string, number>();
  const shopRev = new Map<string, number>();
  for (const o of orders) {
    if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
    const d = vnDate(new Date(o.create_time * 1000));
    for (const it of (o.items ?? []) as any[]) {
      const q = n(it.qty ?? 1);
      const v = n(it.price) * q;
      if (!v) continue;
      const k = `${it.item_id}|${d}`;
      rev.set(k, (rev.get(k) ?? 0) + v);
      units.set(k, (units.get(k) ?? 0) + q);
      shopRev.set(d, (shopRev.get(d) ?? 0) + v);
    }
  }
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
  const statOf = (itemId: number, campaignIds: number[], unitCost: number) => (d: string): DayStat => {
    const revenue = rev.get(`${itemId}|${d}`) ?? 0;
    const expense = campaignIds.reduce((t, id) => t + (exp.get(`${id}|${d}`) ?? 0), 0);
    return {
      revenue,
      expense,
      profit: revenue * k1 - (units.get(`${itemId}|${d}`) ?? 0) * unitCost * k2 - expense * fee,
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
  const decided: string[] = [];

  // ---- 1. Chấm các mã đang thử ----
  for (const t of tests.filter((x) => x.status === "running")) {
    const close = async (status: "kept" | "reverted" | "stopped", result: any, note: string) => {
      await db().from("price_tests").update({ status, decided_on: today, result, note }).eq("id", t.id);
      t.status = status;
      t.decided_on = today;
    };
    const revert = async (why: string): Promise<boolean> => {
      // Chỉ trả giá cũ khi giá trên Shopee vẫn đúng là giá tool đặt.
      const now = await readModels(shopId, t.item_id);
      const touched = t.models.some((m) => {
        const x = now.find((y) => y.model_id === m.model_id);
        return !x || Math.abs(x.current - m.new) > 1 || x.promotion_id !== t.discount_id;
      });
      if (touched) return false;
      await setPrices(shopId, t.discount_id, t.item_id, t.models.map((m) => ({ model_id: m.model_id, price: m.old })));
      await logPrice(shopId, t, range(t.models.map((m) => m.new)), range(t.models.map((m) => m.old)), `Thử giá: trả giá cũ — ${why}`);
      return true;
    };
    const base = t.base;
    if (!base?.days?.length) {
      const ok = await revert("thiếu số ngày nền");
      await close("stopped", { next_dir: t.direction }, ok ? "Thiếu số ngày nền, đã trả giá cũ" : "Thiếu số ngày nền; giá đã bị đổi bởi người/chương trình khác");
      continue;
    }
    const stat = statOf(t.item_id, t.campaign_ids, n(base.unit_cost));
    const testDays = normalDays(t.started_on, yesterday);
    const age = daysBetween(t.started_on, today);
    const isClear = t.cls === "xa_kho";
    if (testDays.length < p.steps_test_days && age < p.steps_max_days) {
      if (testDays.length >= 2) {
        const v = judge(t.direction, base, average(testDays, stat), p.steps_gain_pct, behind || isClear);
        if (v.adjProfit < 0 && v.gain <= -3 * p.steps_gain_pct && !isClear) {
          const ok = await revert(`lỗ rõ sau ${testDays.length} ngày (${v.why})`);
          await close(ok ? "reverted" : "stopped", { ...average(testDays, stat), ...v, early: true }, ok ? `Dừng sớm: ${v.why}` : "Giá đã bị đổi bởi người/chương trình khác");
          decided.push(String(t.name ?? t.item_id));
        }
      }
      continue;
    }
    if (testDays.length < 2) {
      const ok = await revert("không đủ ngày thường để đo");
      await close("stopped", { next_dir: t.direction }, ok ? "Không đủ ngày thường để đo, đã trả giá cũ" : "Không đủ ngày đo; giá đã bị đổi");
      continue;
    }
    const test = average(testDays, stat);
    const v = judge(t.direction, base, test, p.steps_gain_pct, behind || isClear);
    if (v.status === "reverted") {
      const ok = await revert(v.why);
      await close(ok ? "reverted" : "stopped", { ...test, ...v }, ok ? v.why : `${v.why} — nhưng giá đã bị đổi bởi người/chương trình khác nên tool không trả lại`);
    } else {
      await close("kept", { ...test, ...v }, v.why);
    }
    decided.push(String(t.name ?? t.item_id));
  }

  // ---- 2. Mở thử mới ----
  const running = tests.filter((x) => x.status === "running");
  let slots = maxRunning - running.length;
  const saleSoon = [0, 1, 2].some((k) => isPeakDay(s, addDays(today, k)));
  const started: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  if (slots > 0 && !saleSoon) {
    const { data: life } = await db()
      .from("product_lifecycle")
      .select("item_id, name, price, cost_ratio, units30, cls, campaign_ids")
      .eq("shop_id", shopId)
      .in("cls", ["chu_luc", "thuong", "xa_kho"])
      .gte("units30", p.price_test_min_units30)
      .not("cost_ratio", "is", null)
      .order("units30", { ascending: false });
    const { data: campRows } = await db().from("ads_campaigns").select("*").eq("shop_id", shopId).eq("campaign_status", "ongoing");
    const camps = new Map((campRows ?? []).map((c: any) => [Number(c.campaign_id), c]));
    const { data: stepRows } = await db().from("profit_steps").select("campaign_id").eq("shop_id", shopId).eq("status", "running");
    const stepping = new Set((stepRows ?? []).map((r: any) => Number(r.campaign_id)));
    const { data: changes } = await db()
      .from("autopilot_actions")
      .select("campaign_id, created_at")
      .eq("shop_id", shopId)
      .eq("action", "change_roas_target")
      .in("status", ["executed", "dry_run"])
      .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString());
    const lastRoas = new Map<number, string>();
    for (const r of changes ?? []) {
      const d = vnDate(new Date(r.created_at));
      const id = Number(r.campaign_id);
      if (!lastRoas.has(id) || lastRoas.get(id)! < d) lastRoas.set(id, d);
    }
    for (const x of life ?? []) {
      if (slots <= 0) break;
      const itemId = Number(x.item_id);
      if (running.some((t) => t.item_id === itemId)) continue;
      const campIds = ((x.campaign_ids ?? []) as any[]).map(Number).filter((id) => camps.has(id));
      if (campIds.some((id) => stepping.has(id))) {
        skip("đang thử bậc lãi");
        continue;
      }
      if (
        campIds.some((id) => {
          const c = camps.get(id);
          const target = n(c.econ?.target);
          return !target || !n(c.roas_target) || Math.abs(n(c.roas_target) / target - 1) > 0.1;
        })
      ) {
        skip("ROAS quảng cáo của mã chưa ổn định");
        continue;
      }
      const last = tests.find((t) => t.item_id === itemId);
      const since = [last?.decided_on, ...campIds.map((id) => lastRoas.get(id)), addDays(today, -36)].filter(Boolean).sort().pop()!;
      const days = normalDays(since, yesterday).slice(-p.steps_base_days);
      if (days.length < p.steps_min_base_days) {
        skip("chưa đủ ngày nền");
        continue;
      }
      let models;
      try {
        models = await readModels(shopId, itemId);
      } catch {
        skip("không đọc được giá");
        continue;
      }
      if (!models.length || models.some((m) => m.promotion_id !== discountId || !(m.current > 0))) {
        skip("có phân loại không nằm trong chương trình giảm giá của shop");
        continue;
      }
      const unitCost = n(x.cost_ratio) * n(x.price);
      // Giá thấp nhất còn lãi trước QC: giá × k1 > giá vốn × k2 (thêm 10% đệm).
      const minPrice = k1 > 0 ? (unitCost * k2 * 1.1) / k1 : Infinity;
      const isClear = x.cls === "xa_kho";
      let dir: Dir = isClear ? "down" : ((last?.result?.next_dir as Dir) ?? (behind ? "down" : "up"));
      let prices = testPrices(models, dir, pct, minPrice);
      if (!prices && !isClear) {
        dir = dir === "down" ? "up" : "down";
        prices = testPrices(models, dir, pct, minPrice);
      }
      if (!prices) {
        skip("không còn biên đổi giá (chạm giá gốc / giá tối thiểu)");
        continue;
      }
      const base = { ...average(days, statOf(itemId, campIds, unitCost)), unit_cost: Math.round(unitCost) };
      const name = String(x.name ?? "").slice(0, 60);
      try {
        await setPrices(shopId, discountId, itemId, prices.map((m) => ({ model_id: m.model_id, price: m.new })));
      } catch (err) {
        skip(`Shopee từ chối đổi giá`);
        await logPrice(shopId, { item_id: itemId, name }, range(prices.map((m) => m.old)), "lỗi", `Thử giá lỗi: ${String(err).slice(0, 200)}`).catch(() => null);
        continue;
      }
      await logPrice(
        shopId,
        { item_id: itemId, name },
        range(prices.map((m) => m.old)),
        range(prices.map((m) => m.new)),
        `Thử giá ${dir === "down" ? "giảm" : "tăng"} ${pct}%, đo ${p.steps_test_days} ngày thường`
      );
      await db().from("price_tests").insert({
        shop_id: shopId,
        item_id: itemId,
        name,
        campaign_ids: campIds,
        cls: x.cls,
        direction: dir,
        pct,
        discount_id: discountId,
        models: prices,
        started_on: today,
        base,
      });
      started.push(name);
      slots--;
    }
  }
  return { decided: decided.length, started: started.length, running: running.length + started.length, sale_soon: saleSoon, skipped };
}

/** Báo cáo thử giá: việc đã làm và kết quả trong `days` ngày qua + số đang thử. */
export async function priceTestLines(shopId: number, days: number): Promise<string[]> {
  const today = vnDate();
  const since = addDays(today, -days + 1);
  const { data } = await db()
    .from("price_tests")
    .select("*")
    .eq("shop_id", shopId)
    .or(`status.eq.running,decided_on.gte.${since}`)
    .order("started_on", { ascending: false });
  const rows = (data ?? []) as PriceTest[];
  if (!rows.length) return [];
  const out: string[] = [`\n🏷 <b>THỬ GIÁ</b> (tự đổi ±5%, tối đa 3 mã)`];
  const nm = (t: PriceTest) => esc(String(t.name ?? `#${t.item_id}`).slice(0, 34));
  const mark: Record<string, string> = { kept: "✅ giữ giá mới", reverted: "↩️ trả giá cũ", stopped: "⏹ dừng" };
  for (const t of rows.filter((r) => r.status !== "running" && r.decided_on && r.decided_on >= since)) {
    const price = range((t.models ?? []).map((m) => (t.status === "kept" ? m.new : m.old)));
    out.push(`• ${mark[t.status] ?? t.status} ${nm(t)}: giá ${price} — ${esc(String(t.result?.why ?? t.status))}`);
  }
  const run = rows.filter((r) => r.status === "running");
  for (const t of run.filter((r) => r.started_on >= since)) {
    out.push(
      `• Đã ${t.direction === "down" ? "giảm" : "tăng"} giá ${nm(t)}: ${range(t.models.map((m) => m.old))} → <b>${range(t.models.map((m) => m.new))}</b> (${t.pct}%), đo ${4} ngày thường`
    );
  }
  const older = run.filter((r) => r.started_on < since).length;
  if (older) out.push(`• Đang đo: ${older} mã`);
  return out.length > 1 ? out : [];
}
