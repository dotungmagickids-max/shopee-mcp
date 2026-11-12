import { db } from "../supabase";
import { CLASS_BCG, CLASS_VI, daysOfStock, outOfSeason, type ProductClass } from "./classes";
import { econForItem, itemInfos, modelInfo, normalItemIds } from "./launch";
import { costOf, loadCostMap, loadProductStats, productCode, type ProductStats } from "./pancake";
import type { Econ } from "./profit";
import { INVALID_STATUSES, ordersBetween } from "./report";
import { loadSettings, type RuleParams } from "./settings";
import { callShopee, chunk } from "./shopee-call";
import { addDays, vnDate } from "./time";

/**
 * Vòng đời sản phẩm (ma trận BCG, anh chốt 12/11/2026). Mỗi tuần chấm mọi mã đang bán:
 *   - nhóm hiện tại (anh chọn > nhóm của chiến dịch > "Dấu hỏi" nếu chưa chạy quảng cáo),
 *   - đề xuất chuyển nhóm cả hai chiều,
 *   - chẩn đoán phễu (xem → click → mua → lãi) và gợi ý nâng cấp (ảnh, video, mô tả, đánh giá, voucher, KOC…).
 * Kết quả lưu product_lifecycle (trang /admin/lifecycle) và ảnh chụp lượt xem/bán product_snapshots (để tính chênh lệch tuần).
 */

const n = (v: unknown) => Number(v ?? 0) || 0;

export interface LifeMetrics {
  cls: ProductClass;
  inAds: boolean;
  units7: number;
  units30: number;
  stock: number | null;
  dos: number | null; // ngày đủ bán (Infinity = không bán)
  ageDays: number | null;
  oos: boolean; // trái mùa
  profitPct: number | null; // % lãi trên doanh thu thực nhận (QC nếu đủ chi, ngược lại lãi tiềm năng chưa QC)
}

export const LIFE = { starDaily: 2, cowDaily: 0.5, minAdSpend: 100_000 };

/** Đề xuất nhóm mới (null = giữ nguyên). Pure để test. */
export function suggestClass(m: LifeMetrics, p: RuleParams): { cls: ProductClass; why: string } | null {
  const r30 = m.units30 / 30;
  const r7 = m.units7 / 7;
  const profitOk = m.profitPct != null && m.profitPct >= p.profit_target_pct;
  const rate = `bán ${m.units30}/30 ngày (${m.units7}/7 ngày)`;
  const prof = m.profitPct == null ? "chưa có giá vốn" : `lãi ${m.profitPct.toFixed(0)}%`;
  let to: ProductClass;
  let why: string;
  if (m.stock != null && m.stock >= p.clear_min_stock && (m.oos || (m.dos != null && m.dos >= p.clear_stock_days))) {
    to = "xa_kho";
    why = m.oos ? `trái mùa, tồn ${m.stock}` : `tồn ${m.stock}, đủ bán ${m.dos === Infinity ? "mãi (không bán)" : `${Math.round(m.dos!)} ngày`}`;
  } else if (m.ageDays != null && m.ageDays < p.new_days) {
    to = "moi";
    why = `hàng mới ${Math.round(m.ageDays)} ngày`;
  } else if (m.cls === "chu_luc" && (r7 < 0.7 * r30 || (m.profitPct != null && !profitOk))) {
    to = "thuong";
    why = `chững lại: ${rate}, ${prof}`;
  } else if (r30 >= LIFE.starDaily && r7 >= 0.7 * r30 && profitOk && (m.dos == null || m.dos >= p.core_min_stock_days)) {
    to = "chu_luc";
    why = `${rate}, ${prof}`;
  } else if (m.cls === "thuong" && r7 >= 1.5 * r30 && r7 >= LIFE.starDaily && profitOk) {
    to = "chu_luc";
    why = `đang tăng tốc: ${rate}, ${prof}`;
  } else if (r30 >= LIFE.cowDaily && profitOk) {
    to = m.cls === "chu_luc" ? "chu_luc" : "thuong";
    why = `bán đều: ${rate}, ${prof}`;
  } else if (!m.inAds) {
    to = "moi";
    why = `chưa chạy quảng cáo, ${rate}`;
  } else {
    return null;
  }
  return to === m.cls ? null : { cls: to, why };
}

export interface Funnel {
  inAds: boolean;
  units30: number;
  dos: number | null;
  impr14: number;
  clicks14: number;
  orders14: number;
  profitPct: number | null;
  rating: number | null;
  comments: number;
  imageCount: number;
  hasVideo: boolean;
  descLen: number;
}

/** Chẩn đoán phễu + gợi ý nâng cấp. medCtr / medCr: trung vị của shop. Pure để test. */
export function diagnose(f: Funnel, medCtr: number | null, medCr: number | null): { problems: string[]; upgrades: string[] } {
  const problems: string[] = [];
  const up = new Set<string>();
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (f.dos != null && f.dos < 7 && f.units30 > 0) {
    problems.push(`Sắp hết hàng (đủ ${Math.round(f.dos)} ngày)`);
    up.add("Nhập thêm hàng");
  }
  if (!f.inAds && f.units30 / 30 < LIFE.cowDaily) {
    problems.push(`Ít người thấy: chưa chạy quảng cáo, bán ${f.units30}/30 ngày`);
    ["Lên quảng cáo thử 14 ngày", "Flash sale shop", "KOC / tiếp thị liên kết", "Seeding"].forEach((x) => up.add(x));
  }
  if (f.impr14 >= 1000 && medCtr) {
    const ctr = f.clicks14 / f.impr14;
    if (ctr < 0.7 * medCtr) {
      problems.push(`Ít click: CTR ${pct(ctr)} (shop ${pct(medCtr)})`);
      ["Thay ảnh bìa", "Sửa tiêu đề", "Xem lại giá hiển thị"].forEach((x) => up.add(x));
    }
  }
  if (f.clicks14 >= 50 && medCr) {
    const cr = f.orders14 / f.clicks14;
    if (cr < 0.7 * medCr) {
      problems.push(`Click nhiều, ít mua: chuyển đổi ${pct(cr)} (shop ${pct(medCr)})`);
      ["Thêm video", "Viết lại mô tả + bảng size", "Seeding đánh giá", "Voucher shop"].forEach((x) => up.add(x));
    }
  }
  if (f.inAds && f.profitPct != null && f.profitPct < 5) {
    problems.push(`Lãi mỏng khi chạy quảng cáo: ${f.profitPct.toFixed(0)}%`);
    ["Xem lại giá bán / combo", "Giảm giá vốn"].forEach((x) => up.add(x));
  }
  if (f.rating != null && f.rating > 0 && f.rating < 4.7 && f.comments >= 10) {
    problems.push(`Đánh giá ${f.rating.toFixed(1)} sao`);
    up.add("Kiểm tra chất lượng / size");
  }
  if (f.comments < 10) {
    problems.push(`Ít đánh giá (${f.comments})`);
    up.add("Seeding đánh giá");
  }
  if (!f.hasVideo) {
    problems.push("Chưa có video");
    up.add("Thêm video");
  }
  if (f.imageCount < 6) {
    problems.push(`Ít ảnh (${f.imageCount})`);
    up.add("Thêm ảnh");
  }
  if (f.descLen < 300) {
    problems.push("Mô tả ngắn");
    up.add("Viết lại mô tả + bảng size");
  }
  return { problems, upgrades: [...up] };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function computeLifecycle(shopId: number) {
  const started = new Date().toISOString();
  const s = await loadSettings(shopId);
  const p = s.params;
  const { data: st } = await db().from("autopilot_settings").select("econ_summary").eq("shop_id", shopId).maybeSingle();
  const shopEcon = (st?.econ_summary?.shop ?? null) as Econ | null;
  const fee = 1 + p.ad_fee_pct / 100;
  const today = vnDate();
  const month = Number(today.slice(5, 7));

  const ids = await normalItemIds(shopId);
  const infos = await itemInfos(shopId, ids);

  // Lượt xem, đã bán (luỹ kế), đánh giá.
  const extra = new Map<number, { views: number; sale: number; rating: number | null; comments: number }>();
  for (const part of chunk(ids, 50)) {
    const res = await callShopee(shopId, "product.get_item_extra_info", { item_id_list: part.join(",") });
    for (const it of res.response?.item_list ?? []) {
      extra.set(Number(it.item_id), { views: n(it.views), sale: n(it.sale), rating: it.rating_star == null ? null : Number(it.rating_star), comments: n(it.comment_count) });
    }
  }

  // Bán 30 / 7 ngày + giá vốn từ đơn.
  const costs = await loadCostMap(shopId);
  const now = Math.floor(Date.now() / 1000);
  const orders = await ordersBetween(shopId, now - 30 * 86400, now);
  const agg = new Map<number, { units: number; units7: number; revenue: number; costedRevenue: number; cogs: number; codes: Set<string> }>();
  for (const o of orders) {
    if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
    const recent = o.create_time >= now - 7 * 86400;
    for (const it of (o.items ?? []) as any[]) {
      const id = Number(it.item_id);
      const qty = Number(it.qty ?? 1);
      const price = Number(it.price ?? 0);
      if (!(qty > 0) || !(price > 0)) continue;
      const a = agg.get(id) ?? { units: 0, units7: 0, revenue: 0, costedRevenue: 0, cogs: 0, codes: new Set<string>() };
      a.units += qty;
      if (recent) a.units7 += qty;
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
  const costedEnough = (a?: { revenue: number; costedRevenue: number }) => !!a && a.costedRevenue > 0 && a.costedRevenue >= a.revenue * 0.5;
  const models = new Map<number, Awaited<ReturnType<typeof modelInfo>>>();
  for (const part of chunk(ids.filter((id) => !costedEnough(agg.get(id))), 8)) {
    await Promise.all(
      part.map(async (id) => {
        try {
          models.set(id, await modelInfo(shopId, id, costs));
        } catch {
          /* bỏ qua */
        }
      })
    );
  }

  // Chiến dịch theo sản phẩm + số quảng cáo 14 ngày (D-15…D-2).
  const { data: camps } = await db()
    .from("ads_campaigns")
    .select("campaign_id, item_ids, campaign_status, econ")
    .eq("shop_id", shopId)
    .in("campaign_status", ["ongoing", "paused", "scheduled"]);
  const campsByItem = new Map<number, { id: number; econ: Econ | null }[]>();
  for (const c of camps ?? []) {
    for (const it of (c.item_ids ?? []).map(Number)) {
      if (!campsByItem.has(it)) campsByItem.set(it, []);
      campsByItem.get(it)!.push({ id: Number(c.campaign_id), econ: c.econ as Econ | null });
    }
  }
  const campIds = (camps ?? []).map((c) => Number(c.campaign_id));
  const adsByCamp = new Map<number, { impr: number; clicks: number; spend: number; gmv: number; orders: number }>();
  for (const part of chunk(campIds, 100)) {
    const { data } = await db()
      .from("ads_campaign_daily")
      .select("campaign_id, impression, clicks, expense, broad_gmv, broad_order")
      .eq("shop_id", shopId)
      .gte("date", addDays(today, -15))
      .lte("date", addDays(today, -2))
      .in("campaign_id", part)
      .limit(10000);
    for (const r of data ?? []) {
      const id = Number(r.campaign_id);
      const a = adsByCamp.get(id) ?? { impr: 0, clicks: 0, spend: 0, gmv: 0, orders: 0 };
      a.impr += n(r.impression);
      a.clicks += n(r.clicks);
      a.spend += n(r.expense);
      a.gmv += n(r.broad_gmv);
      a.orders += n(r.broad_order);
      adsByCamp.set(id, a);
    }
  }
  // Chiến dịch nhiều sản phẩm: chỉ tính số quảng cáo cho chiến dịch một sản phẩm (chia ra không chính xác).
  const adsOfItem = (id: number) => {
    const t = { impr: 0, clicks: 0, spend: 0, gmv: 0, orders: 0 };
    for (const c of campsByItem.get(id) ?? []) {
      const one = (camps ?? []).find((x) => Number(x.campaign_id) === c.id)?.item_ids?.length === 1;
      const a = adsByCamp.get(c.id);
      if (!a || !one) continue;
      t.impr += a.impr;
      t.clicks += a.clicks;
      t.spend += a.spend;
      t.gmv += a.gmv;
      t.orders += a.orders;
    }
    return t;
  };

  const { data: manual } = await db().from("product_classes").select("item_id, manual_class").eq("shop_id", shopId);
  const manualMap = new Map((manual ?? []).filter((m) => m.manual_class).map((m) => [Number(m.item_id), m.manual_class as ProductClass]));
  const stats = await loadProductStats();

  // Trung vị CTR / chuyển đổi của shop (chỉ mã đủ số).
  const ctrs: number[] = [];
  const crs: number[] = [];
  for (const id of ids) {
    const a = adsOfItem(id);
    if (a.impr >= 1000) ctrs.push(a.clicks / a.impr);
    if (a.clicks >= 50) crs.push(a.orders / a.clicks);
  }
  const medCtr = median(ctrs);
  const medCr = median(crs);

  const rows: Record<string, unknown>[] = [];
  const snaps: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const info = infos.get(id);
    if (!info || info.status !== "NORMAL") continue;
    const a = agg.get(id);
    const mi = models.get(id);
    const codes = new Set<string>([...(a?.codes ?? []), ...(mi?.codes ?? [])]);
    const sku = productCode(info.item_sku);
    if (sku) codes.add(sku);
    const ps = [...codes].map((c) => stats.get(c)).filter(Boolean) as ProductStats[];
    const price = a && a.units > 0 ? a.revenue / a.units : info.price ?? mi?.price ?? null;
    const costRatio = costedEnough(a) ? a!.cogs / a!.costedRevenue : mi?.costRatio ?? null;
    const stock = ps.length ? ps.reduce((t, x) => t + x.stock, 0) : info.stock ?? mi?.stock ?? null;
    const pancakeDaily = ps.reduce((t, x) => t + x.sellingAvg, 0);
    const units30 = a?.units ?? 0;
    const created = ps.map((x) => x.created).filter((t): t is number => t != null);
    const createdAt = created.length ? Math.min(...created) : info.created;
    const dos = daysOfStock({ stock, dailySales: pancakeDaily > 0 ? pancakeDaily : units30 / 30 });
    const oos = outOfSeason(new Set(ps.flatMap((x) => [...x.categories])), month);

    const itemCamps = campsByItem.get(id) ?? [];
    const inAds = itemCamps.length > 0;
    const ads = adsOfItem(id);
    const econ = costRatio != null && shopEcon?.margin ? econForItem(shopEcon, costRatio, price, p) : null;
    const keep = econ ? (1 - econ.cancel_rate) * (1 - econ.return_rate) : null;
    let profitPct: number | null = null;
    let profitSource: "qc" | "tiem_nang" | null = null;
    if (econ && keep) {
      if (ads.spend >= LIFE.minAdSpend && ads.gmv > 0) {
        profitPct = (100 * (ads.gmv * econ.margin - ads.spend * fee)) / (ads.gmv * keep);
        profitSource = "qc";
      } else {
        profitPct = (100 * econ.margin) / keep;
        profitSource = "tiem_nang";
      }
    }
    const campCls = itemCamps.map((c) => c.econ?.class).find(Boolean) as ProductClass | undefined;
    const manualCls = manualMap.get(id);
    const cls: ProductClass = manualCls ?? campCls ?? "moi";
    const clsSource = manualCls ? "manual" : campCls ? "auto" : "chua_qc";
    const ex = extra.get(id);
    const m: LifeMetrics = {
      cls,
      inAds,
      units7: a?.units7 ?? 0,
      units30,
      stock,
      dos,
      ageDays: createdAt ? (Date.now() - createdAt) / 86400_000 : null,
      oos,
      profitPct,
    };
    const sug = suggestClass(m, p);
    const dia = diagnose(
      {
        inAds,
        units30,
        dos,
        impr14: ads.impr,
        clicks14: ads.clicks,
        orders14: ads.orders,
        profitPct: profitSource === "qc" ? profitPct : null,
        rating: ex?.rating ?? null,
        comments: ex?.comments ?? 0,
        imageCount: info.image_count,
        hasVideo: info.has_video,
        descLen: info.desc_len,
      },
      medCtr,
      medCr
    );
    counts[cls] = (counts[cls] ?? 0) + 1;
    if (sug) counts.suggest = (counts.suggest ?? 0) + 1;
    rows.push({
      shop_id: shopId,
      item_id: id,
      name: info.name,
      image: info.image,
      price: price ? Math.round(price) : null,
      stock,
      days_of_stock: dos == null ? null : dos === Infinity ? 9999 : Math.round(dos),
      units7: m.units7,
      units30,
      cost_ratio: costRatio == null ? null : Math.round(costRatio * 1000) / 1000,
      breakeven: econ?.breakeven ?? null,
      profit_pct: profitPct == null ? null : Math.round(profitPct * 10) / 10,
      profit_source: profitSource,
      in_ads: inAds,
      campaign_ids: itemCamps.map((c) => c.id),
      ad_spend14: Math.round(ads.spend),
      ad_gmv14: Math.round(ads.gmv),
      ad_impr14: ads.impr,
      ad_clicks14: ads.clicks,
      ad_orders14: ads.orders,
      views: ex?.views ?? null,
      sold_total: ex?.sale ?? null,
      rating: ex?.rating == null ? null : Math.round(ex.rating * 100) / 100,
      comments: ex?.comments ?? null,
      image_count: info.image_count,
      has_video: info.has_video,
      desc_len: info.desc_len,
      cls,
      cls_source: clsSource,
      suggested_cls: sug?.cls ?? null,
      suggest_reason: sug ? `${CLASS_VI[cls]} → ${CLASS_VI[sug.cls]} (${CLASS_BCG[sug.cls]}): ${sug.why}` : null,
      problems: dia.problems,
      upgrades: dia.upgrades,
      updated_at: new Date().toISOString(),
    });
    snaps.push({ shop_id: shopId, item_id: id, date: today, views: ex?.views ?? null, sold_total: ex?.sale ?? null, rating: ex?.rating ?? null, comments: ex?.comments ?? null, units30 });
  }
  for (const part of chunk(rows, 200)) {
    const { error } = await db().from("product_lifecycle").upsert(part);
    if (error) throw new Error(`product_lifecycle: ${error.message}`);
  }
  for (const part of chunk(snaps, 300)) {
    const { error } = await db().from("product_snapshots").upsert(part);
    if (error) throw new Error(`product_snapshots: ${error.message}`);
  }
  // Mã không còn bán: bỏ khỏi bảng.
  await db().from("product_lifecycle").delete().eq("shop_id", shopId).lt("updated_at", started);
  return { items: rows.length, suggest: counts.suggest ?? 0, classes: counts, med_ctr: medCtr, med_cr: medCr };
}
