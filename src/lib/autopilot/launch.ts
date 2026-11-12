import { db } from "../supabase";
import { propose } from "./actions";
import { CLASS_BCG, CLASS_VI, classify, daysOfStock, targetForClass, type ClassInput, type ProductClass } from "./classes";
import { costOf, loadCostMap, loadProductStats, normSku, productCode, type ProductStats } from "./pancake";
import type { Econ } from "./profit";
import { INVALID_STATUSES, ordersBetween } from "./report";
import { automationBlocked, loadSettings, type RuleParams } from "./settings";
import { callShopee, chunk } from "./shopee-call";
import { esc, sendTelegram, vnd } from "./telegram";
import { addDays, vnDate } from "./time";

const n = (v: unknown) => Number(v ?? 0) || 0;
const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Lên quảng cáo cho sản phẩm chưa chạy (anh chốt 12/11/2026): mỗi tuần tool rà các mã đang bán chưa có chiến dịch,
 * chọn mã đủ tồn, có lãi được khi chạy quảng cáo, đang bán tự nhiên tốt hoặc là hàng mới, rồi gửi đề xuất từng mã
 * (ảnh + ngân sách + ROAS mục tiêu). Anh duyệt thì tool tạo chiến dịch GMV Max. Không bao giờ tự chạy.
 */

export interface LaunchCandidate {
  item_id: number;
  name: string;
  image: string | null;
  price: number | null;
  stock: number | null;
  units30: number;
  cost_ratio: number;
  breakeven: number;
  cls: ProductClass;
  cls_reason: string;
  target: number;
  target_label: string;
  score: number;
  days_of_stock: number | null;
}

export interface ItemInfo {
  item_id: number;
  name: string;
  image: string | null;
  price: number | null;
  stock: number | null;
  status: string;
  created: number | null; // ms
  item_sku: string | null;
  image_count: number;
  has_video: boolean;
  desc_len: number;
}

/** Mọi sản phẩm đang bán (NORMAL) của shop. */
export async function normalItemIds(shopId: number): Promise<number[]> {
  const ids: number[] = [];
  let offset = 0;
  for (let page = 0; page < 30; page++) {
    const res = await callShopee(shopId, "product.get_item_list", { offset, page_size: 100, item_status: ["NORMAL"] });
    for (const it of res.response?.item ?? []) ids.push(Number(it.item_id));
    if (!res.response?.has_next_page) break;
    offset = Number(res.response?.next_offset ?? offset + 100);
  }
  return ids;
}

export async function itemInfos(shopId: number, ids: number[]): Promise<Map<number, ItemInfo>> {
  const out = new Map<number, ItemInfo>();
  for (const part of chunk(ids, 50)) {
    const res = await callShopee(shopId, "product.get_item_base_info", { item_id_list: part.join(",") });
    for (const it of res.response?.item_list ?? []) {
      const created = it.create_time ? (typeof it.create_time === "number" ? it.create_time * 1000 : Date.parse(it.create_time)) : null;
      out.set(Number(it.item_id), {
        item_id: Number(it.item_id),
        name: String(it.item_name ?? it.item_id),
        image: it.image?.image_url_list?.[0] ?? null,
        price: it.price_info?.[0]?.current_price != null ? Number(it.price_info[0].current_price) : null,
        stock: it.stock_info_v2?.summary_info?.total_available_stock != null ? Number(it.stock_info_v2.summary_info.total_available_stock) : null,
        status: String(it.item_status ?? "NORMAL"),
        created: Number.isFinite(created) ? created : null,
        item_sku: it.item_sku || null,
        image_count: (it.image?.image_id_list ?? []).length,
        has_video: (it.video_info ?? []).length > 0,
        desc_len:
          String(it.description ?? "").length ||
          (it.description_info?.extended_description?.field_list ?? []).reduce((t: number, f: any) => t + String(f?.text ?? "").length, 0),
      });
    }
  }
  return out;
}

/**
 * Phân loại (model) của sản phẩm: SKU từng phân loại để ghép giá vốn Pancake, giá bán và tồn Shopee.
 * Sản phẩm chưa bán trong 30 ngày không có SKU trong đơn, nên phải đọc ở đây.
 */
export async function modelInfo(
  shopId: number,
  itemId: number,
  costs: Map<string, number>
): Promise<{ costRatio: number | null; price: number | null; stock: number; codes: Set<string> }> {
  const res = await callShopee(shopId, "product.get_model_list", { item_id: itemId });
  let costSum = 0;
  let priceSum = 0;
  let k = 0;
  let stock = 0;
  const codes = new Set<string>();
  for (const m of res.response?.model ?? []) {
    stock += Number(m.stock_info_v2?.summary_info?.total_available_stock ?? 0);
    const price = Number(m.price_info?.[0]?.current_price ?? 0);
    const cost = costs.get(normSku(m.model_sku));
    const code = productCode(m.model_sku);
    if (code) codes.add(code);
    if (cost && price > 0) {
      costSum += cost;
      priceSum += price;
      k++;
    }
  }
  return { costRatio: k ? costSum / priceSum : null, price: k ? priceSum / k : null, stock, codes };
}

/** Biên lãi trước QC trên 1đ GMV của một sản phẩm, dùng tỉ lệ phí/hủy/hoàn của shop và giá vốn riêng. */
export function econForItem(shop: Econ, costRatio: number, price: number | null, p: RuleParams): Econ {
  const keepC = 1 - shop.cancel_rate;
  const extra = price && price > 0 ? p.extra_cost_per_unit / price : 0;
  const margin = keepC * (shop.payout * (1 - shop.return_rate) - costRatio * (1 - shop.return_back_rate) - extra - (shop.return_fee_ratio ?? 0));
  const fee = 1 + (shop.ad_fee_pct ?? 0) / 100;
  return { ...shop, cost_ratio: costRatio, margin, breakeven: margin > 0 ? round1(fee / margin) : null, source: "shop" };
}

/** Điểm ưu tiên: bán tự nhiên 30 ngày là tín hiệu cầu; hàng mới được cộng; hàng xả trừ; tồn nhiều cộng chút. */
export function launchScore(units30: number, cls: ProductClass, stock: number | null): number {
  return units30 + (cls === "moi" ? 15 : 0) - (cls === "xa_kho" ? 10 : 0) + Math.min((stock ?? 0) / 20, 10);
}

export async function findLaunchCandidates(shopId: number) {
  const s = await loadSettings(shopId);
  const p = s.params;
  const { data: st } = await db().from("autopilot_settings").select("econ_summary").eq("shop_id", shopId).maybeSingle();
  const shopEcon = (st?.econ_summary?.shop ?? null) as Econ | null;
  if (!shopEcon?.margin) return { candidates: [] as LaunchCandidate[], skipped: "Chưa có số kinh tế của shop (chạy job costs trước)", stats: {} };

  // Sản phẩm đã có chiến dịch, hoặc đã đề xuất gần đây (kể cả anh đã bỏ qua): không đề xuất lại.
  const { data: camps } = await db()
    .from("ads_campaigns")
    .select("item_ids")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  const inAds = new Set((camps ?? []).flatMap((c) => (c.item_ids ?? []).map(Number)));
  const since = new Date(Date.now() - p.launch_cooldown_days * 86400_000).toISOString();
  const { data: past } = await db()
    .from("autopilot_actions")
    .select("after")
    .eq("shop_id", shopId)
    .eq("action", "launch")
    .gte("created_at", since);
  const recent = new Set((past ?? []).map((r) => Number(r.after?.item_id)));

  const all = await normalItemIds(shopId);
  const pool = all.filter((id) => !inAds.has(id) && !recent.has(id));

  // Bán tự nhiên 30 ngày + giá vốn từ đơn thật.
  const costs = await loadCostMap(shopId);
  const now = Math.floor(Date.now() / 1000);
  const orders = await ordersBetween(shopId, now - 30 * 86400, now);
  const agg = new Map<number, { units: number; revenue: number; costedRevenue: number; cogs: number; codes: Set<string> }>();
  for (const o of orders) {
    if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
    for (const it of (o.items ?? []) as any[]) {
      const id = Number(it.item_id);
      const qty = Number(it.qty ?? 1);
      const price = Number(it.price ?? 0);
      if (!(qty > 0) || !(price > 0)) continue;
      const a = agg.get(id) ?? { units: 0, revenue: 0, costedRevenue: 0, cogs: 0, codes: new Set<string>() };
      a.units += qty;
      a.revenue += price * qty;
      const c = costOf(costs, it);
      if (c != null) {
        a.costedRevenue += price * qty;
        a.cogs += c * qty;
      }
      const code = productCode(it.model_sku) ?? productCode(it.item_sku);
      if (code) a.codes.add(code);
      agg.set(id, a);
    }
  }

  const infos = await itemInfos(shopId, pool);
  const stats = await loadProductStats();
  // Đọc phân loại song song (8 mã/lượt) cho mã chưa có giá vốn từ đơn.
  const needModels = pool.filter((id) => {
    const a = agg.get(id);
    return infos.get(id)?.status === "NORMAL" && !(a && a.costedRevenue > 0 && a.costedRevenue >= a.revenue * 0.5);
  });
  const models = new Map<number, Awaited<ReturnType<typeof modelInfo>>>();
  for (const part of chunk(needModels, 8)) {
    await Promise.all(
      part.map(async (id) => {
        try {
          models.set(id, await modelInfo(shopId, id, costs));
        } catch {
          /* bỏ qua mã đọc lỗi */
        }
      })
    );
  }
  const month = Number(vnDate().slice(5, 7));
  const out: LaunchCandidate[] = [];
  const counts = { pool: pool.length, no_cost: 0, low_stock: 0, no_margin: 0 };
  for (const id of pool) {
    const info = infos.get(id);
    if (!info || info.status !== "NORMAL") continue;
    const a = agg.get(id);
    const codes = new Set(a?.codes ?? []);
    const fromSku = productCode(info.item_sku);
    if (fromSku) codes.add(fromSku);
    const m = /\b([A-Z]{2,4}\d{5,6})\b/.exec(info.name.toUpperCase());
    if (m) codes.add(m[1]);
    const ps = [...codes].map((c) => stats.get(c)).filter(Boolean) as ProductStats[];

    let price = a && a.units > 0 ? a.revenue / a.units : info.price;
    let costRatio: number | null = null;
    let modelStock: number | null = null;
    if (a && a.costedRevenue > 0 && a.costedRevenue >= a.revenue * 0.5) costRatio = a.cogs / a.costedRevenue;
    else {
      // Chưa bán (hoặc bán chưa có giá vốn): ghép từng phân loại với Pancake.
      const mi = models.get(id);
      if (mi) {
        modelStock = mi.stock;
        for (const c of mi.codes) {
          codes.add(c);
          const st = stats.get(c);
          if (st && !ps.includes(st)) ps.push(st);
        }
        if (mi.costRatio != null) {
          costRatio = mi.costRatio;
          price = price ?? mi.price;
        }
      }
      if (costRatio == null) {
        const cost = ps.map((x) => x.cost).find((c): c is number => c != null && c > 0);
        if (cost && price && price > 0) costRatio = cost / price;
      }
    }
    if (costRatio == null || !(costRatio > 0) || costRatio >= 1) {
      counts.no_cost++;
      continue;
    }
    const stock = ps.length ? ps.reduce((t, x) => t + x.stock, 0) : info.stock ?? modelStock;
    const pancakeDaily = ps.reduce((t, x) => t + x.sellingAvg, 0);
    const units30 = a?.units ?? 0;
    const created = ps.map((x) => x.created).filter((t): t is number => t != null);
    const createdAt = created.length ? Math.min(...created) : info.created;
    const input: ClassInput = {
      units30,
      stock,
      dailySales: pancakeDaily > 0 ? pancakeDaily : units30 / 30,
      categories: new Set(ps.flatMap((x) => [...x.categories])),
      ageDays: createdAt ? (Date.now() - createdAt) / 86400_000 : null,
      costRatio,
      month,
    };
    const dos = daysOfStock(input);
    if (stock == null || stock < p.launch_min_stock || (dos != null && dos < p.launch_min_stock_days)) {
      counts.low_stock++;
      continue;
    }
    const econ = econForItem(shopEcon, costRatio, price, p);
    if (!econ.breakeven || econ.breakeven > p.launch_max_breakeven) {
      counts.no_margin++;
      continue;
    }
    const c = classify(input, p);
    const t = targetForClass(econ, c.cls, p);
    if (!t.target) {
      counts.no_margin++;
      continue;
    }
    out.push({
      item_id: id,
      name: info.name,
      image: info.image,
      price: price ? Math.round(price) : null,
      stock,
      units30,
      cost_ratio: Math.round(costRatio * 1000) / 1000,
      breakeven: econ.breakeven,
      cls: c.cls,
      cls_reason: c.reason,
      target: t.target,
      target_label: t.label,
      score: launchScore(units30, c.cls, stock),
      days_of_stock: dos == null ? null : dos === Infinity ? 9999 : Math.round(dos),
    });
  }
  out.sort((x, y) => y.score - x.score);
  return { candidates: out, stats: { items: all.length, in_ads: inAds.size, ...counts } };
}

/** Đề xuất lên quảng cáo: mỗi mã một tin có ảnh, luôn chờ anh duyệt. Tối đa launch_max_per_week mã/tuần. */
export async function proposeLaunches(shopId: number, source = "rule:launch") {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const { candidates, stats, skipped } = await findLaunchCandidates(shopId);
  if (skipped) return { skipped };
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { count } = await db()
    .from("autopilot_actions")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("action", "launch")
    .gte("created_at", since);
  const room = Math.max(0, s.params.launch_max_per_week - (count ?? 0));
  const picked = candidates.slice(0, room);
  for (const c of picked) {
    let suggest: number | null = null;
    try {
      const rec = await callShopee(shopId, "ads.get_product_recommended_roi_target", { reference_id: crypto.randomUUID(), item_id: c.item_id });
      suggest = rec.response?.exact?.value ?? null;
    } catch {
      suggest = null;
    }
    await propose(
      {
        shop_id: shopId,
        campaign_id: null,
        action: "launch",
        before: {},
        after: {
          item_id: c.item_id,
          name: c.name,
          image: c.image,
          budget: s.start_budget,
          roas_target: c.target,
          cls: c.cls,
          shopee_suggest: suggest,
        },
        reason: [
          `${CLASS_VI[c.cls]} (${CLASS_BCG[c.cls]}): ${c.cls_reason}`,
          `bán tự nhiên ${c.units30} cái/30 ngày, tồn ${c.stock}${c.days_of_stock != null && c.days_of_stock < 9999 ? ` (đủ bán ${c.days_of_stock} ngày)` : ""}`,
          `giá ${c.price ? vnd(c.price) : "?"}, giá vốn ${Math.round(c.cost_ratio * 100)}%, hòa vốn ROAS ${c.breakeven}`,
          `ROAS mục tiêu ${c.target} (${c.target_label})${suggest != null ? `, Shopee gợi ý ${suggest}` : ""}`,
        ].join("; "),
        source,
      },
      3 * 24 * 60,
      s
    );
  }
  if (!picked.length) {
    await sendTelegram(
      `🔎 <b>Rà mã chưa chạy quảng cáo</b> — ${esc(s.shop_name ?? String(shopId))}\nKhông có mã mới đủ điều kiện tuần này (${candidates.length} ứng viên, ${room} suất trống).`
    );
  }
  return { proposed: picked.length, candidates: candidates.length, room, stats };
}

// ---------------------------------------------------------------------------
// Đánh giá hàng Mới (Dấu hỏi) sau 14 ngày chạy
// ---------------------------------------------------------------------------

export interface NewVerdict {
  campaign_id: number;
  name: string;
  verdict: "len_nhom" | "dung" | "giu";
  to?: ProductClass;
  text: string;
}

/** Quyết định cho một mã Mới từ số 14 ngày. Pure để test. */
export function judgeNew(
  m: { spend: number; gmv: number; orders: number; breakeven: number | null; thuongTarget: number | null; autoClass?: ProductClass },
  p: RuleParams
): { verdict: NewVerdict["verdict"]; to?: ProductClass; why: string } {
  const roas = m.spend > 0 ? m.gmv / m.spend : 0;
  const nums = `14 ngày: chi ${vnd(m.spend)}, ${m.orders} đơn, ROAS ${roas.toFixed(1)}`;
  if (m.orders >= p.new_promote_orders && m.thuongTarget && roas >= m.thuongTarget) {
    const to: ProductClass = m.autoClass === "chu_luc" ? "chu_luc" : "thuong";
    return { verdict: "len_nhom", to, why: `${nums} ≥ ${m.thuongTarget} (lãi 10%) — bán đều, có lãi` };
  }
  if (m.spend >= p.new_stop_min_spend && (m.orders < 3 || (m.breakeven && roas < m.breakeven * 0.8))) {
    return { verdict: "dung", why: `${nums}${m.breakeven ? `, hòa vốn ${m.breakeven}` : ""} — không ra đơn / lỗ` };
  }
  return { verdict: "giu", why: `${nums} — chưa đủ dữ liệu, chạy tiếp` };
}

export async function reviewNewProducts(shopId: number) {
  const s = await loadSettings(shopId);
  const blocked = automationBlocked(s);
  if (blocked) return { skipped: blocked };
  const p = s.params;
  const minStart = Date.now() / 1000 - 14 * 86400;
  const { data: camps } = await db()
    .from("ads_campaigns")
    .select("campaign_id, ad_name, econ, start_time")
    .eq("shop_id", shopId)
    .eq("campaign_status", "ongoing");
  const fresh = (camps ?? []).filter((c) => c.econ?.class === "moi" && n(c.start_time) > 0 && n(c.start_time) <= minStart);
  if (!fresh.length) return { reviewed: 0 };
  const today = vnDate();
  const { data: daily } = await db()
    .from("ads_campaign_daily")
    .select("campaign_id, expense, broad_gmv, broad_order")
    .eq("shop_id", shopId)
    .gte("date", addDays(today, -15))
    .lte("date", addDays(today, -2))
    .in("campaign_id", fresh.map((c) => Number(c.campaign_id)))
    .limit(10000);
  const sum = new Map<number, { spend: number; gmv: number; orders: number }>();
  for (const r of daily ?? []) {
    const id = Number(r.campaign_id);
    const a = sum.get(id) ?? { spend: 0, gmv: 0, orders: 0 };
    a.spend += n(r.expense);
    a.gmv += n(r.broad_gmv);
    a.orders += n(r.broad_order);
    sum.set(id, a);
  }
  const lines: string[] = [];
  let proposals = 0;
  for (const c of fresh) {
    const id = Number(c.campaign_id);
    const e = c.econ as Econ;
    const thuong = e?.margin ? targetForClass(e, "thuong", p).target : null;
    const j = judgeNew({ ...(sum.get(id) ?? { spend: 0, gmv: 0, orders: 0 }), breakeven: e?.breakeven ?? null, thuongTarget: thuong, autoClass: e?.auto_class }, p);
    const name = String(c.ad_name ?? id).slice(0, 45);
    if (j.verdict === "len_nhom" && j.to) {
      await propose(
        {
          shop_id: shopId,
          campaign_id: id,
          action: "set_class",
          before: { cls: "moi" },
          after: { cls: j.to },
          reason: `Hàng Mới chạy đủ 14 ngày: ${j.why}. Chuyển sang ${CLASS_VI[j.to]} (${CLASS_BCG[j.to]}).`,
          source: "rule:new_review",
        },
        3 * 24 * 60,
        s
      );
      proposals++;
      lines.push(`⬆️ ${esc(name)}: đề xuất lên ${CLASS_VI[j.to]} — ${esc(j.why)}`);
    } else if (j.verdict === "dung") {
      lines.push(`⛔ ${esc(name)}: nên dừng hoặc làm mới — ${esc(j.why)}`);
    } else {
      lines.push(`⏳ ${esc(name)}: ${esc(j.why)}`);
    }
  }
  await sendTelegram(`🧪 <b>Đánh giá hàng Mới (Dấu hỏi)</b> — ${esc(s.shop_name ?? String(shopId))}\n${lines.join("\n")}`);
  return { reviewed: fresh.length, proposals };
}
