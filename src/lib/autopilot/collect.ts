import { db } from "../supabase";
import { callShopee, chunk } from "./shopee-call";
import { addDays, apiDate, fromApiDate, vnDate, vnDayStartUnix } from "./time";

const ACTIVE = ["ongoing", "paused", "scheduled"];
const FINISHED = ["closed", "ended", "deleted"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// ---------------------------------------------------------------------------
// Danh sách và cấu hình chiến dịch
// ---------------------------------------------------------------------------

/** Làm mới ads_campaigns nếu đã cũ hơn maxAgeMinutes. Trả về số chiến dịch đang chạy/tạm dừng. */
export async function refreshCampaigns(shopId: number, maxAgeMinutes = 55): Promise<{ refreshed: boolean; active: number }> {
  const { data: known, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id, campaign_status, campaign_budget, roas_target, updated_at")
    .eq("shop_id", shopId);
  if (error) throw new Error(error.message);

  const newest = Math.max(0, ...(known ?? []).map((r) => Date.parse(r.updated_at)));
  if (known?.length && Date.now() - newest < maxAgeMinutes * 60_000) {
    return { refreshed: false, active: known.filter((r) => ACTIVE.includes(r.campaign_status)).length };
  }

  const ids: number[] = [];
  for (let offset = 0; offset < 20_000; offset += 100) {
    const res = await callShopee(shopId, "ads.get_product_level_campaign_id_list", { ad_type: "all", offset, limit: 100 });
    for (const c of res.response?.campaign_list ?? []) ids.push(Number(c.campaign_id));
    if (!res.response?.has_next_page) break;
  }

  // Chiến dịch đã kết thúc thì không bao giờ chạy lại: bỏ qua để đỡ gọi API.
  const knownMap = new Map((known ?? []).map((r) => [Number(r.campaign_id), r]));
  const toFetch = ids.filter((id) => !FINISHED.includes(knownMap.get(id)?.campaign_status ?? ""));

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  for (const batch of chunk(toFetch, 100)) {
    const res = await callShopee(shopId, "ads.get_product_level_campaign_setting_info", {
      info_type_list: "1,3",
      campaign_id_list: batch.join(","),
    });
    for (const c of res.response?.campaign_list ?? []) {
      const ci = c.common_info ?? {};
      rows.push({
        shop_id: shopId,
        campaign_id: Number(c.campaign_id),
        ad_type: ci.ad_type ?? null,
        ad_name: ci.ad_name ?? null,
        bidding_method: ci.bidding_method ?? null,
        campaign_placement: ci.campaign_placement ?? null,
        campaign_status: ci.campaign_status ?? null,
        campaign_budget: ci.campaign_budget ?? null,
        roas_target: c.auto_bidding_info?.roas_target ?? null,
        item_ids: (ci.item_id_list ?? []).map(Number),
        start_time: toUnix(ci.campaign_duration?.start_time),
        end_time: toUnix(ci.campaign_duration?.end_time),
        updated_at: now,
      });
    }
  }

  const history = rows
    .filter((r) => {
      const old = knownMap.get(r.campaign_id as number);
      return (
        !old ||
        old.campaign_status !== r.campaign_status ||
        Number(old.campaign_budget) !== Number(r.campaign_budget) ||
        Number(old.roas_target ?? NaN) !== Number(r.roas_target ?? NaN)
      );
    })
    .filter((r) => !FINISHED.includes(String(r.campaign_status)) || knownMap.has(r.campaign_id as number))
    .map((r) => ({
      shop_id: shopId,
      campaign_id: r.campaign_id,
      campaign_status: r.campaign_status,
      campaign_budget: r.campaign_budget,
      roas_target: r.roas_target,
    }));

  for (const batch of chunk(rows, 500)) {
    const { error: e } = await db().from("ads_campaigns").upsert(batch);
    if (e) throw new Error(`ads_campaigns: ${e.message}`);
  }
  // Đánh dấu chiến dịch đã kết thúc là "đã kiểm tra" để lần sau biết danh sách còn mới.
  if (rows.length === 0 && known?.length) {
    await db().from("ads_campaigns").update({ updated_at: now }).eq("shop_id", shopId).eq("campaign_id", known[0].campaign_id);
  }
  for (const batch of chunk(history, 500)) {
    await db().from("ads_campaign_history").insert(batch);
  }
  return { refreshed: true, active: rows.filter((r) => ACTIVE.includes(String(r.campaign_status))).length };
}

function toUnix(v: unknown): number | null {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  return v == null ? null : Number(v);
}

export async function activeCampaignIds(shopId: number): Promise<number[]> {
  const { data, error } = await db()
    .from("ads_campaigns")
    .select("campaign_id")
    .eq("shop_id", shopId)
    .in("campaign_status", ACTIVE);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => Number(r.campaign_id));
}

// ---------------------------------------------------------------------------
// Hiệu quả theo giờ
// ---------------------------------------------------------------------------

/** Lấy hiệu quả theo giờ của các chiến dịch cho một ngày (giờ VN). */
export async function collectCampaignHourly(shopId: number, date: string, campaignIds?: number[]): Promise<number> {
  const ids = campaignIds ?? (await activeCampaignIds(shopId));
  const now = new Date().toISOString();
  let count = 0;
  for (const batch of chunk(ids, 100)) {
    const res = await callShopee(shopId, "ads.get_product_campaign_hourly_performance", {
      performance_date: apiDate(date),
      campaign_id_list: batch.join(","),
    });
    const groups = Array.isArray(res.response) ? res.response : [res.response];
    const rows: Record<string, unknown>[] = [];
    for (const g of groups) {
      for (const c of g?.campaign_list ?? []) {
        for (const m of c.metrics_list ?? []) {
          rows.push({
            shop_id: shopId,
            campaign_id: Number(c.campaign_id),
            date: m.date ? fromApiDate(m.date) : date,
            hour: num(m.hour),
            impression: num(m.impression),
            clicks: num(m.clicks),
            expense: num(m.expense),
            broad_order: num(m.broad_order),
            broad_gmv: num(m.broad_gmv),
            direct_order: num(m.direct_order),
            direct_gmv: num(m.direct_gmv),
            updated_at: now,
          });
        }
      }
    }
    for (const part of chunk(rows, 1000)) {
      const { error } = await db().from("ads_campaign_hourly").upsert(part);
      if (error) throw new Error(`ads_campaign_hourly: ${error.message}`);
    }
    count += rows.length;
  }
  return count;
}

export async function collectShopHourly(shopId: number, date: string): Promise<number> {
  const res = await callShopee(shopId, "ads.get_all_cpc_ads_hourly_performance", { performance_date: apiDate(date) });
  const now = new Date().toISOString();
  const rows = (res.response ?? []).map((m: any) => ({
    shop_id: shopId,
    date: m.date ? fromApiDate(m.date) : date,
    hour: num(m.hour),
    impression: num(m.impression),
    clicks: num(m.clicks),
    expense: num(m.expense),
    broad_order: num(m.broad_order),
    broad_gmv: num(m.broad_gmv),
    direct_order: num(m.direct_order),
    direct_gmv: num(m.direct_gmv),
    updated_at: now,
  }));
  if (rows.length) {
    const { error } = await db().from("ads_shop_hourly").upsert(rows);
    if (error) throw new Error(`ads_shop_hourly: ${error.message}`);
  }
  return rows.length;
}

export async function collectBalance(shopId: number): Promise<number> {
  const res = await callShopee(shopId, "ads.get_total_balance");
  const balance = num(res.response?.total_balance);
  const ts = res.response?.data_timestamp;
  await db()
    .from("ads_balance_snapshots")
    .insert({
      shop_id: shopId,
      total_balance: balance,
      data_time: ts instanceof Date ? ts.toISOString() : typeof ts === "number" ? new Date(ts * 1000).toISOString() : ts ?? null,
    });
  return balance;
}

/** GMV Max cấp shop: chỉ có số liệu theo ngày. */
export async function collectGmsDaily(shopId: number, date: string): Promise<number> {
  const res = await callShopee(shopId, "ads.get_gms_campaign_performance", {
    start_date: apiDate(date),
    end_date: apiDate(date),
  });
  const r = res.response;
  if (!r?.campaign_id || !r.report) return 0;
  const rep = Array.isArray(r.report) ? r.report[0] : r.report;
  const { error } = await db().from("ads_gms_daily").upsert({
    shop_id: shopId,
    campaign_id: Number(r.campaign_id),
    date,
    impression: num(rep?.impression),
    clicks: num(rep?.clicks),
    expense: num(rep?.expense),
    broad_order: num(rep?.broad_order),
    broad_gmv: num(rep?.broad_gmv),
    direct_order: num(rep?.direct_order),
    direct_gmv: num(rep?.direct_gmv),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`ads_gms_daily: ${error.message}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Đơn hàng
// ---------------------------------------------------------------------------

async function listOrders(
  shopId: number,
  field: "create_time" | "update_time",
  from: number,
  to: number
): Promise<{ order_sn: string; order_status: string }[]> {
  const out: { order_sn: string; order_status: string }[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const res = await callShopee(shopId, "order.get_order_list", {
      time_range_field: field,
      time_from: from,
      time_to: to,
      page_size: 100,
      cursor,
      response_optional_fields: "order_status",
    });
    out.push(...(res.response?.order_list ?? []));
    if (!res.response?.more || !res.response?.next_cursor) break;
    cursor = res.response.next_cursor;
  }
  return out;
}

/** Lấy chi tiết và upsert vào bảng orders. */
async function fetchOrderDetails(shopId: number, orderSns: string[]): Promise<number> {
  let count = 0;
  for (const batch of chunk(orderSns, 50)) {
    const res = await callShopee(shopId, "order.get_order_detail", {
      // GET: phải nối bằng dấu phẩy; truyền mảng thì Shopee chỉ đọc phần tử đầu.
      order_sn_list: batch.join(","),
      response_optional_fields: "total_amount,item_list",
    });
    const now = new Date().toISOString();
    const rows = (res.response?.order_list ?? []).map((o: any) => ({
      shop_id: shopId,
      order_sn: o.order_sn,
      create_time: toUnix(o.create_time) ?? 0,
      order_status: o.order_status ?? null,
      total_amount: o.total_amount ?? null,
      items: (o.item_list ?? []).map((i: any) => ({
        item_id: i.item_id,
        model_id: i.model_id,
        item_name: i.item_name,
        item_sku: i.item_sku || null,
        model_sku: i.model_sku || null,
        qty: i.model_quantity_purchased,
        price: i.model_discounted_price,
      })),
      detail_fetched_at: now,
      updated_at: now,
    }));
    if (rows.length) {
      const { error } = await db().from("orders").upsert(rows);
      if (error) throw new Error(`orders: ${error.message}`);
    }
    count += rows.length;
  }
  return count;
}

/**
 * Đồng bộ đơn theo khoảng thời gian: đơn mới thì lấy chi tiết, đơn đã có mà đổi trạng thái thì cập nhật.
 * maxDetails giới hạn số đơn lấy chi tiết mỗi lần chạy (phần còn lại để lần sau).
 */
export async function syncOrders(
  shopId: number,
  field: "create_time" | "update_time",
  from: number,
  to: number,
  maxDetails = 300
): Promise<{ listed: number; detailed: number; statusUpdated: number }> {
  const listed = await listOrders(shopId, field, from, to);
  if (!listed.length) return { listed: 0, detailed: 0, statusUpdated: 0 };

  const existing = new Map<string, string | null>();
  for (const batch of chunk(listed.map((o) => o.order_sn), 200)) {
    const { data } = await db().from("orders").select("order_sn, order_status").in("order_sn", batch);
    for (const r of data ?? []) existing.set(r.order_sn, r.order_status);
  }
  const fresh = listed.filter((o) => !existing.has(o.order_sn)).map((o) => o.order_sn);
  // Đơn đổi trạng thái: lấy lại chi tiết (số tiền có thể đổi khi hủy/hoàn).
  const changed = listed.filter((o) => existing.has(o.order_sn) && existing.get(o.order_sn) !== o.order_status);
  const detailTargets = [...fresh, ...changed.map((o) => o.order_sn)].slice(0, maxDetails);
  const detailed = await fetchOrderDetails(shopId, detailTargets);
  return { listed: listed.length, detailed, statusUpdated: changed.length };
}

export async function syncOrdersForDay(shopId: number, date: string) {
  const from = vnDayStartUnix(date);
  const to = Math.min(vnDayStartUnix(addDays(date, 1)) - 1, Math.floor(Date.now() / 1000));
  return syncOrders(shopId, "create_time", from, to);
}

// ---------------------------------------------------------------------------
// Escrow (tiền về)
// ---------------------------------------------------------------------------

export async function syncEscrow(shopId: number, orderSns: string[]): Promise<number> {
  let count = 0;
  for (const batch of chunk(orderSns, 20)) {
    const res = await callShopee(shopId, "payment.get_escrow_detail_batch", { order_sn_list: batch });
    const now = new Date().toISOString();
    const rows = (res.response ?? [])
      .map((r: any) => r.escrow_detail)
      .filter((d: any) => d?.order_sn)
      .map((d: any) => {
        const oi = d.order_income ?? {};
        const { items: _items, ...rawIncome } = oi;
        return {
          order_sn: d.order_sn,
          shop_id: shopId,
          escrow_amount: oi.escrow_amount ?? null,
          buyer_total_amount: oi.buyer_total_amount ?? null,
          commission_fee: oi.commission_fee ?? null,
          service_fee: oi.service_fee ?? null,
          seller_transaction_fee: oi.seller_transaction_fee ?? null,
          ams_commission_fee: oi.order_ams_commission_fee ?? null,
          withholding_tax: oi.withholding_tax ?? null,
          shopee_discount: oi.shopee_discount ?? null,
          voucher_from_shopee: oi.voucher_from_shopee ?? null,
          refund_amount: num(oi.seller_return_refund) + num(oi.drc_adjustable_refund),
          raw: rawIncome,
          updated_at: now,
        };
      });
    if (rows.length) {
      const { error } = await db().from("order_escrow").upsert(rows);
      if (error) throw new Error(`order_escrow: ${error.message}`);
    }
    count += rows.length;
  }
  return count;
}

/** Đơn đã hoàn tất trong 30 ngày mà chưa có escrow (hoặc escrow lấy trước khi hoàn tất). */
export async function escrowCandidates(shopId: number, limit = 1000): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const { data: done } = await db()
    .from("orders")
    .select("order_sn, updated_at")
    .eq("shop_id", shopId)
    .eq("order_status", "COMPLETED")
    .gte("create_time", since)
    .limit(5000);
  if (!done?.length) return [];
  const have = new Map<string, string>();
  for (const batch of chunk(done.map((o) => o.order_sn), 200)) {
    const { data } = await db().from("order_escrow").select("order_sn, updated_at").in("order_sn", batch);
    for (const r of data ?? []) have.set(r.order_sn, r.updated_at);
  }
  return done
    .filter((o) => !have.has(o.order_sn) || Date.parse(have.get(o.order_sn)!) < Date.parse(o.updated_at))
    .map((o) => o.order_sn)
    .slice(0, limit);
}

export { vnDate };
