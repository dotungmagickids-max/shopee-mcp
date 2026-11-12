import { allRows, db } from "../supabase";
import type { ShopConf } from "./config";
import { INVALID_STATUSES, dayReport, ordersBetween } from "./report";
import { isPeakDay, loadSettings, SALE_TIER_VI, saleTier } from "./settings";
import { callShopee, chunk } from "./shopee-call";
import { esc, vnd } from "./telegram";
import { addDays, vnDate, vnDayStartUnix } from "./time";

/**
 * Báo cáo sáng 8h (anh chốt 12/11/2026): tổng quát Shopee theo 3 mảng ĐƠN HÀNG · MARKETING · TIỀN,
 * cộng việc tool đã tự làm, việc tồn đọng và đề xuất. Mỗi phần lỗi riêng thì bỏ qua phần đó, báo cáo vẫn gửi.
 */

const n = (v: unknown) => Number(v ?? 0) || 0;
const RETURN_OPEN = ["REQUESTED", "PROCESSING", "JUDGING", "SELLER_DISPUTE"];
/** Thời điểm (giây) từ số giây, mili giây, chuỗi ISO hoặc Date (SDK Shopee đổi timestamp thành ngày giờ). */
function unix(v: unknown): number {
  if (v == null || v === "") return 0;
  if (v instanceof Date) return v.getTime() / 1000;
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t / 1000 : 0;
  }
  const x = Number(v);
  return x > 1e11 ? x / 1000 : x;
}
/** So với trung bình ngày thường: "+12% so với ngày thường", hoặc "gấp 22 lần ngày thường" khi chênh lớn (ngày sale). */
function vsNormal(v: number, base: number): string {
  const r = v / base;
  if (r >= 3) return `gấp ${Math.round(r)} lần ngày thường`;
  const x = 100 * r - 100;
  return `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x))}% so với ngày thường`;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Đơn đang chờ xử lý trên Shopee (15 ngày gần nhất) theo trạng thái. */
async function ordersInStatus(shopId: number, status: string): Promise<string[]> {
  const now = Math.floor(Date.now() / 1000);
  const out: string[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const res = await callShopee(shopId, "order.get_order_list", {
      time_range_field: "create_time",
      time_from: now - 15 * 86400,
      time_to: now,
      page_size: 100,
      cursor,
      order_status: status,
    });
    for (const o of res.response?.order_list ?? []) out.push(String(o.order_sn));
    if (!res.response?.more) break;
    cursor = String(res.response?.next_cursor ?? "");
    if (!cursor) break;
  }
  return out;
}

/** Đơn chờ giao: tổng, quá hạn giao, sắp tới hạn (trong 24h). */
async function toShip(shopId: number) {
  const sns = [...(await ordersInStatus(shopId, "READY_TO_SHIP")), ...(await ordersInStatus(shopId, "PROCESSED"))];
  const now = Date.now() / 1000;
  let overdue = 0;
  let dueSoon = 0;
  for (const part of chunk(sns, 50)) {
    const res = await callShopee(shopId, "order.get_order_detail", { order_sn_list: part.join(","), response_optional_fields: "ship_by_date" });
    for (const o of res.response?.order_list ?? []) {
      const by = unix(o.ship_by_date);
      if (!by) continue;
      if (by < now) overdue++;
      else if (by < now + 86400) dueSoon++;
    }
  }
  return { total: sns.length, overdue, dueSoon };
}

/** Số dư ví Shopee (người bán) = số dư sau giao dịch gần nhất. */
async function walletBalance(shopId: number): Promise<number | null> {
  const res = await callShopee(shopId, "payment.get_wallet_transaction_list", { page_no: 0, page_size: 1 });
  const t = res.response?.transaction_list?.[0];
  return t?.current_balance != null ? Number(t.current_balance) : null;
}

/** Tiền đơn hàng chờ Shopee giải ngân. */
async function pendingIncome(shopId: number): Promise<number | null> {
  const res = await callShopee(shopId, "payment.get_income_overview", {});
  const v = res.response?.total_income?.pending_amount;
  return v != null ? Number(v) : null;
}

/** Việc tool đã tự làm 24h qua (không chờ duyệt): tăng ngân sách, reset 0h, đổi ROAS mục tiêu. */
export async function autoSummary(shopId: number): Promise<string[]> {
  const { data } = await db()
    .from("autopilot_actions")
    .select("campaign_id, action, before, after, status, source")
    .eq("shop_id", shopId)
    .eq("decided_by", "auto")
    .in("source", ["rule:scale_up", "rule:restore", "rule:reset", "rule:roas_target"])
    .not("campaign_id", "is", null)
    .gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString())
    .order("created_at");
  const rows = data ?? [];
  if (!rows.length) return [];
  const ok = (r: any) => r.status === "executed" || r.status === "dry_run";
  const out: string[] = [];

  const ups = rows.filter((r) => (r.source === "rule:scale_up" || r.source === "rule:restore") && r.action === "change_budget");
  const upsDone = ups.filter(ok);
  const byCamp = new Map<number, { from: number; to: number; times: number }>();
  for (const r of upsDone) {
    const id = Number(r.campaign_id);
    const cur = byCamp.get(id) ?? { from: n(r.before?.budget), to: 0, times: 0 };
    cur.to = n(r.after?.budget);
    cur.times++;
    byCamp.set(id, cur);
  }
  const roas = rows.filter((r) => r.source === "rule:roas_target" && r.action === "change_roas_target");
  const ids = [...new Set([...byCamp.keys(), ...roas.map((r) => Number(r.campaign_id))])];
  const { data: names } = ids.length
    ? await db().from("ads_campaigns").select("campaign_id, ad_name").eq("shop_id", shopId).in("campaign_id", ids)
    : { data: [] as any[] };
  const nameOf = new Map((names ?? []).map((x: any) => [Number(x.campaign_id), String(x.ad_name ?? "")]));
  const nm = (id: number) => esc((nameOf.get(id) ?? `#${id}`).slice(0, 38));

  if (upsDone.length) {
    const added = [...byCamp.values()].reduce((t, c) => t + Math.max(0, c.to - c.from), 0);
    out.push(
      `• Tự tăng ngân sách: <b>${upsDone.length}</b> lần, ${byCamp.size} chiến dịch, thêm ${vnd(added)}${
        ups.length > upsDone.length ? ` (${ups.length - upsDone.length} lần bị trần/cầu chì chặn)` : ""
      }`
    );
    for (const [id, c] of [...byCamp.entries()].sort((a, b) => b[1].to - b[1].from - (a[1].to - a[1].from)).slice(0, 5)) {
      out.push(`   – ${nm(id)}: ${vnd(c.from)} → ${vnd(c.to)} (${c.times} lần)`);
    }
  }
  const resets = rows.filter((r) => r.source === "rule:reset" && ok(r));
  if (resets.length) {
    const down = resets.filter((r) => r.action === "change_budget" && n(r.after?.budget) < n(r.before?.budget)).length;
    out.push(`• Reset 0h: ${resets.length} thay đổi (${down} chiến dịch về mức khởi điểm)`);
  }
  const roasDone = roas.filter(ok);
  if (roasDone.length) {
    const live = roasDone.filter((r) => r.status === "executed").length;
    out.push(`• Đổi ROAS mục tiêu: ${roasDone.length} chiến dịch${live < roasDone.length ? ` (${roasDone.length - live} chỉ ghi nhận, chưa bật gửi thật)` : ""}`);
    for (const r of roasDone.slice(0, 5)) out.push(`   – ${nm(Number(r.campaign_id))}: ${r.before?.roas_target ?? "-"} → ${r.after?.roas_target}`);
  }
  return out;
}

/** Báo cáo một shop. */
export async function shopMorning(shop: ShopConf): Promise<string[]> {
  const shopId = shop.shopId;
  const today = vnDate();
  const yesterday = addDays(today, -1);
  const s = await loadSettings(shopId);
  const r = await dayReport(shopId, yesterday);
  const lines: string[] = [`\n🏪 <b>${esc(shop.name)}</b>`];
  const todo: string[] = [];

  // ---------- ĐƠN HÀNG ----------
  // So với trung bình 7 ngày thường gần nhất (bỏ ngày sale lớn và ngày ngay trước).
  const normalDays: string[] = [];
  for (let d = 2; normalDays.length < 7 && d <= 21; d++) {
    const date = addDays(today, -d);
    if (!isPeakDay(s, date)) normalDays.push(date);
  }
  const base = await safe(async () => {
    const from = vnDayStartUnix(normalDays[normalDays.length - 1]);
    const to = vnDayStartUnix(addDays(normalDays[0], 1));
    const os = await ordersBetween(shopId, from, to);
    const set = new Set(normalDays);
    let cnt = 0;
    let rev = 0;
    for (const o of os) {
      if (INVALID_STATUSES.includes(o.order_status ?? "")) continue;
      if (!set.has(vnDate(new Date(o.create_time * 1000)))) continue;
      cnt++;
      rev += n(o.total_amount);
    }
    return { orders: cnt / normalDays.length, revenue: rev / normalDays.length };
  });
  const tier = saleTier(s, yesterday);
  const total = r.orders + r.cancelled;
  const cancelRate = total ? (100 * r.cancelled) / total : 0;
  lines.push(`\n📦 <b>ĐƠN HÀNG</b> hôm qua${tier !== "thuong" ? ` (${SALE_TIER_VI[tier]})` : ""}`);
  lines.push(
    `• Đơn: <b>${r.orders}</b>${base?.orders ? ` (${vsNormal(r.orders, base.orders)})` : ""} · hủy ${r.cancelled} (${Math.round(cancelRate)}%)`
  );
  lines.push(`• Doanh số: <b>${vnd(r.revenue)}</b>${base?.revenue ? ` (${vsNormal(r.revenue, base.revenue)})` : ""}`);
  const ship = await safe(() => toShip(shopId));
  if (ship) {
    lines.push(`• Chờ giao: <b>${ship.total}</b> đơn${ship.overdue ? ` · <b>⚠️ ${ship.overdue} quá hạn giao</b>` : ""}${ship.dueSoon ? ` · ${ship.dueSoon} tới hạn trong 24h` : ""}`);
    if (ship.overdue) todo.push(`Giao gấp ${ship.overdue} đơn quá hạn (bị tính điểm phạt Sao Quả Tạ)`);
    else if (ship.dueSoon) todo.push(`Giao ${ship.dueSoon} đơn tới hạn trong 24h`);
  }
  const inCancel = await safe(async () => (await ordersInStatus(shopId, "IN_CANCEL")).length);
  if (inCancel) {
    lines.push(`• Yêu cầu hủy chờ xử lý: <b>${inCancel}</b>`);
    todo.push(`Phản hồi ${inCancel} yêu cầu hủy`);
  }
  const returnsOpen = await safe(async () => {
    const { count } = await db()
      .from("shopee_returns")
      .select("return_sn", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .in("status", RETURN_OPEN);
    return count ?? 0;
  });
  if (returnsOpen) {
    lines.push(`• Trả hàng / hoàn tiền đang mở: <b>${returnsOpen}</b>`);
    todo.push(`Xử lý ${returnsOpen} yêu cầu trả hàng (quá hạn Shopee tự chấp nhận)`);
  }
  if (cancelRate >= 15 && total >= 20) todo.push(`Tỉ lệ hủy hôm qua ${Math.round(cancelRate)}%: xem lý do hủy`);

  // ---------- MARKETING ----------
  const fee = 1 + s.params.ad_fee_pct / 100;
  lines.push(`\n📣 <b>MARKETING</b>`);
  if (r.adExpense > 0) {
    lines.push(`• Chi QC: <b>${vnd(r.adExpense * fee)}</b> (Shopee báo ${vnd(r.adExpense)} + phí nạp) · ROAS <b>${r.roasShopee.toFixed(1)}</b>`);
    lines.push(`• Đơn từ QC ${r.adOrders} · chi phí/đơn ${vnd(r.costPerOrder * fee)} · QC/doanh số ${r.revenue > 0 ? Math.round((100 * r.adExpense * fee) / r.revenue) : 0}%`);
  } else {
    lines.push(`• Không chạy quảng cáo`);
  }
  lines.push(...(await safe(() => autoSummary(shopId))) ?? []);
  const pending = await safe(async () => {
    const { count } = await db()
      .from("autopilot_actions")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .eq("status", "proposed")
      .is("parent_id", null)
      .gt("expires_at", new Date().toISOString());
    return count ?? 0;
  });
  if (pending) {
    lines.push(`• Đề xuất chờ anh duyệt: <b>${pending}</b>`);
    todo.push(`Duyệt ${pending} đề xuất (Telegram hoặc dashboard)`);
  }

  // ---------- TIỀN ----------
  lines.push(`\n💰 <b>TIỀN</b>`);
  if (r.profit != null) {
    lines.push(
      `• Lãi sau QC hôm qua (ước): <b>${vnd(r.profit)}</b>${r.revenue > 0 ? ` (${Math.round((100 * r.profit) / r.revenue)}% doanh số)` : ""}${
        r.profitNote ? ` <i>${esc(r.profitNote)}</i>` : ""
      }`
    );
  }
  const wallet = await safe(() => walletBalance(shopId));
  if (wallet != null) lines.push(`• Số dư ví Shopee: <b>${vnd(wallet)}</b>`);
  const incoming = await safe(() => pendingIncome(shopId));
  if (incoming != null) lines.push(`• Tiền đơn hàng sắp về (Shopee chưa giải ngân): <b>${vnd(incoming)}</b>`);
  if (r.balance != null) {
    const avg = await safe(async () => {
      const rows = await allRows(() =>
        db().from("ads_shop_daily").select("date, expense").eq("shop_id", shopId).in("date", normalDays).order("date")
      );
      const e = rows.reduce((t: number, x: any) => t + n(x.expense), 0);
      return rows.length ? e / rows.length : 0;
    });
    const daysLeft = avg ? r.balance / avg : null;
    lines.push(`• Số dư ví quảng cáo: <b>${vnd(r.balance)}</b>${daysLeft != null ? ` (đủ chạy ~${daysLeft.toFixed(1)} ngày thường)` : ""}`);
    if (daysLeft != null && daysLeft < 3) todo.push(`Nạp ví quảng cáo (còn ~${daysLeft.toFixed(1)} ngày)`);
  }

  // ---------- HÀNG / ĐỀ XUẤT ----------
  const low = await safe(async () => {
    const { data } = await db()
      .from("product_lifecycle")
      .select("name, days_of_stock, units30")
      .eq("shop_id", shopId)
      .lt("days_of_stock", 7)
      .gte("units30", 20)
      .order("units30", { ascending: false })
      .limit(3);
    return data ?? [];
  });
  if (low?.length) {
    todo.push(`Nhập hàng (tồn dưới 7 ngày):${low.map((x: any) => `${esc(String(x.name).slice(0, 28))} (${x.days_of_stock} ngày)`).join("; ")}`);
  }
  const moves = await safe(async () => {
    const { count } = await db()
      .from("product_lifecycle")
      .select("item_id", { count: "exact", head: true })
      .eq("shop_id", shopId)
      .not("suggested_cls", "is", null);
    return count ?? 0;
  });
  if (moves) todo.push(`${moves} mã có đề xuất chuyển nhóm (trang Vòng đời sản phẩm)`);

  lines.push(`\n✅ <b>VIỆC CẦN LÀM</b>`);
  lines.push(...(todo.length ? todo.map((t) => `• ${t}`) : ["• Không có việc tồn đọng"]));
  return lines;
}
