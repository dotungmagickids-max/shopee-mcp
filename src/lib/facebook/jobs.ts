/**
 * Nhân viên Facebook — job chạy theo lịch (pg_cron → /api/jobs/fb-*):
 *   fb-report  08:05  thu số hôm qua; báo hiệu quả, lãi/lỗ, content hiệu quả 7 ngày, lãi theo mã, đề xuất
 *   fb-watch   mỗi giờ 9h–23h  thu số hôm nay, cảnh báo quảng cáo chi nhiều mà 0 đơn, tài khoản lỗi
 * Giai đoạn 1 (anh chốt 13/11): chỉ báo cáo + đề xuất. Nút Đồng ý chỉ ghi nhận; thực thi trên Meta chỉ bật khi FB_EXECUTE=1.
 */
import { db } from "../supabase";
import { weeklyWhyLines } from "../feedback";
import { esc, vnd } from "../autopilot/telegram";
import { vnDate, vnHour } from "../autopilot/time";
import { ACCOUNT_STATUS, adInsights, adState, budgetTarget, listAccounts, pauseAd, scaledBudget, setDailyBudget, type MetaAccount } from "./meta";
import { ordersByAd } from "./orders";
import {
  loadRules,
  outcome,
  codeFromName,
  groupRows,
  pauseCandidates,
  profit,
  rankAds,
  ratio,
  realSpend,
  scaleCandidates,
  shiftDay,
  sumByAccount,
  type AdDay,
  type Proposal,
} from "./rules";
import { fbAlertOnce, fbButtons, fbEdit, fbSend, fbSetupWebhook } from "./telegram";

export async function isStopped(): Promise<boolean> {
  const { data } = await db().from("fb_settings").select("stopped").eq("id", 1).maybeSingle();
  return Boolean(data?.stopped);
}

export async function setStopped(stopped: boolean): Promise<void> {
  await db().from("fb_settings").upsert({ id: 1, stopped, updated_at: new Date().toISOString() });
}

/** Thu số một ngày: Meta (chi) + Pancake (đơn theo ad_id), ghi fb_ad_daily. */
export async function collectDay(day: string, accounts?: MetaAccount[]) {
  const accs = accounts ?? (await listAccounts());
  const orders = await ordersByAd(day);
  const rows: AdDay[] = [];
  const errors: string[] = [];
  for (const acc of accs) {
    try {
      for (const r of await adInsights(acc.id, day)) {
        const o = orders.get(r.ad_id) ?? { orders: 0, revenue: 0, cogs: 0, product_code: null };
        rows.push({
          ngay: day,
          ad_id: r.ad_id,
          account_id: acc.id,
          account_name: acc.name,
          campaign_name: r.campaign_name,
          adset_name: r.adset_name,
          ad_name: r.ad_name,
          spend: r.spend,
          orders: o.orders,
          revenue: Math.round(o.revenue),
          cpas: acc.cpas,
          meta_purchases: r.purchases,
          meta_purchase_value: r.purchase_value,
          cogs: o.cogs,
          product_code: o.product_code ?? codeFromName(r.ad_name, r.campaign_name),
        });
      }
    } catch (err) {
      errors.push(`${acc.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db()
      .from("fb_ad_daily")
      .upsert(rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: new Date().toISOString() })));
    if (error) throw new Error(`fb_ad_daily: ${error.message}`);
  }
  return { rows, errors, accounts: accs };
}

async function loadHistory(from: string, to: string): Promise<AdDay[]> {
  const { data, error } = await db().from("fb_ad_daily").select("*").gte("ngay", from).lte("ngay", to).limit(10000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    ...r,
    spend: Number(r.spend),
    revenue: Number(r.revenue),
    cogs: Number(r.cogs ?? 0),
    meta_purchase_value: Number(r.meta_purchase_value),
  }));
}

const pct = (q: number | null) => (q == null ? "∞" : `${Math.round(q * 100)}%`);

const lailo = (p: number | null) => (p == null ? "-" : `${p >= 0 ? "lãi" : "<b>lỗ</b>"} ${vnd(Math.abs(p))}`);

function adLine(a: AdDay): string {
  const o = outcome(a);
  return `• ${esc(a.ad_name ?? a.ad_id)} — <i>${esc(a.account_name)} / ${esc(a.campaign_name ?? "-")}</i>\n  chi ${vnd(realSpend(a.spend))}, ${o.orders} đơn, ${vnd(o.revenue)} → ${pct(ratio(a))}, ${lailo(profit(a))}`;
}

/** Hàng tồn theo mã: tồn và số ngày còn bán (từ pancake_variations). */
export type StockInfo = Map<string, { stock: number; days: number | null }>;

/**
 * Nội dung báo sáng (hàm thuần trên số đã thu).
 * rows = số hôm qua; week = 7 ngày gần nhất (để chấm content), stock = tồn theo mã (để cảnh báo hết hàng).
 */
export function morningText(day: string, rows: AdDay[], errors: string[] = [], week: AdDay[] = [], stock: StockInfo = new Map()): string {
  const rules = loadRules();
  const accs = sumByAccount(rows);
  const pancake = accs.filter((a) => !a.cpas);
  const cpas = accs.filter((a) => a.cpas);
  const tot = (xs: typeof accs) => {
    const spendReal = xs.reduce((s, a) => s + a.spendReal, 0);
    const revenue = xs.reduce((s, a) => s + a.revenue, 0);
    return { spendReal, revenue, orders: xs.reduce((s, a) => s + a.orders, 0), ratio: revenue > 0 ? spendReal / revenue : null };
  };
  const t = tot(pancake);
  const profitOf = (accountId: string) => rows.filter((r) => r.account_id === accountId).reduce((s, r) => s + (profit(r) ?? 0), 0);
  const totalProfit = rows.reduce((s, r) => s + (profit(r) ?? 0), 0);
  const lines = [
    `📘 <b>Facebook ${day.split("-").reverse().join("/")}</b>`,
    `Chi thật ${vnd(t.spendReal)} — ${t.orders} đơn — ${vnd(t.revenue)} → <b>${pct(t.ratio)}</b> (mục tiêu &lt; ${Math.round(rules.targetRatio * 100)}%)`,
    `Lãi ước tính: <b>${lailo(totalProfit)}</b> (đã trừ giá vốn, QC, thuế 1,5%, đóng gói; chưa trừ hoàn)`,
    "",
    "<b>Theo tài khoản</b>",
    ...pancake.map((a) => `• ${esc(a.account_name)} (${a.account_id}): ${vnd(a.spendReal)}, ${a.orders} đơn, ${pct(a.ratio)}, ${lailo(profitOf(a.account_id))}`),
  ];
  if (cpas.length) {
    const c = tot(cpas);
    lines.push("", `<b>CPAS → Shopee</b> (số mua Meta ghi nhận): chi ${vnd(c.spendReal)}, ${c.orders} đơn, ${vnd(c.revenue)} → ${pct(c.ratio)}`);
  }

  // Lãi theo mã sản phẩm (hôm qua)
  const byCode = groupRows(rows, (a) => a.product_code ?? null, (a) => a.product_code ?? "").filter((g) => g.spend > 0);
  if (byCode.length) {
    lines.push("", "<b>Theo mã sản phẩm</b>");
    for (const g of byCode.sort((x, y) => y.spend - x.spend).slice(0, 8)) {
      const st = stock.get(g.key);
      lines.push(
        `• ${esc(g.key)}: chi ${vnd(realSpend(g.spend))}, ${g.orders} đơn, ${pct(g.ratio)}, ${lailo(g.profit)}${st && st.days != null && st.days < 7 ? ` · ⚠️ tồn ${st.stock}, đủ ~${Math.max(0, Math.round(st.days))} ngày` : ""}`
      );
    }
  }

  const { best, worst } = rankAds(rows, rules);
  if (best.length) lines.push("", "✅ <b>Quảng cáo tốt nhất hôm qua</b>", ...best.map(adLine));
  if (worst.length) lines.push("", "⚠️ <b>Quảng cáo kém nhất hôm qua</b>", ...worst.map(adLine));

  // Content hiệu quả 7 ngày: gom theo tên quảng cáo (quy ước [Mã]-Pxx-Axx/Vxx)
  const content = groupRows(week, (a) => a.ad_name ?? a.ad_id, (a) => `${a.ad_name ?? a.ad_id} (${a.account_name})`).filter(
    (g) => realSpend(g.spend) >= rules.rankMinSpend
  );
  const winners = content.filter((g) => g.profit > 0 && g.ratio != null && g.ratio <= rules.targetRatio).sort((a, b) => b.profit - a.profit).slice(0, 3);
  const losers = content.filter((g) => g.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 3);
  if (winners.length || losers.length) {
    lines.push("", "🎯 <b>Content 7 ngày</b>");
    for (const g of winners) lines.push(`• 🟢 ${esc(g.label)}: ${g.orders} đơn, ${pct(g.ratio)}, ${lailo(g.profit)}`);
    for (const g of losers) lines.push(`• 🔴 ${esc(g.label)}: ${g.orders} đơn, ${pct(g.ratio)}, ${lailo(g.profit)}`);
  }

  // Đề xuất thêm (theo sổ tay Kiều Trang)
  const ideas: string[] = [];
  for (const g of winners.slice(0, 2)) ideas.push(`Nhân bản content thắng ${esc(g.label)} sang tài khoản/page khác (không động vào bản đang chạy).`);
  for (const g of byCode) {
    const st = stock.get(g.key);
    if (st && st.days != null && st.days < 7 && g.spend > 0) ideas.push(`${esc(g.key)} sắp hết hàng (đủ ~${Math.max(0, Math.round(st.days))} ngày): không tăng ngân sách, chuẩn bị tái.`);
  }
  if (t.ratio != null && t.ratio > rules.targetRatio) ideas.push(`Tỉ lệ chung ${pct(t.ratio)} vượt mục tiêu: ưu tiên cắt các quảng cáo lỗ ở trên trước khi mở test mới.`);
  if (ideas.length) lines.push("", "💡 <b>Đề xuất thêm</b>", ...ideas.slice(0, 5).map((x) => `• ${x}`));

  if (errors.length) lines.push("", `Không đọc được: ${esc(errors.join("; ").slice(0, 500))}`);
  return lines.join("\n");
}

/** Tồn và số ngày còn bán theo mã sản phẩm (bảng pancake_variations đồng bộ đêm). */
async function loadStock(): Promise<StockInfo> {
  const out: StockInfo = new Map();
  for (let page = 0; page < 20; page++) {
    const { data, error } = await db()
      .from("pancake_variations")
      .select("product_code, stock, selling_avg")
      .range(page * 1000, page * 1000 + 999);
    if (error) return out;
    for (const r of data ?? []) {
      const code = String(r.product_code ?? "");
      if (!code) continue;
      const cur = out.get(code) ?? { stock: 0, days: null, rate: 0 } as any;
      cur.stock += Math.max(0, Number(r.stock ?? 0));
      cur.rate = (cur.rate ?? 0) + Number(r.selling_avg ?? 0);
      out.set(code, cur);
    }
    if (!data || data.length < 1000) break;
  }
  for (const v of out.values() as any) v.days = v.rate > 0 ? v.stock / v.rate : null;
  return out;
}

/** Ghi đề xuất và gửi kèm nút. Không gửi trùng (cùng quảng cáo, cùng loại, cùng ngày). */
async function propose(p: Proposal, day: string): Promise<boolean> {
  const { data: dup } = await db()
    .from("fb_proposals")
    .select("id")
    .eq("ad_id", p.ad.ad_id)
    .eq("kind", p.kind)
    .eq("ngay", day)
    .maybeSingle();
  if (dup) return false;
  const { data, error } = await db()
    .from("fb_proposals")
    .insert({
      ngay: day,
      kind: p.kind,
      ad_id: p.ad.ad_id,
      ad_name: p.ad.ad_name,
      account_id: p.ad.account_id,
      account_name: p.ad.account_name,
      campaign_name: p.ad.campaign_name,
      reason: p.reason,
      status: "proposed",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`fb_proposals: ${error?.message ?? "không ghi được"}`);
  const title = p.kind === "pause" ? "⏸ Đề xuất TẮT quảng cáo" : "📈 Đề xuất TĂNG ngân sách";
  const msgId = await fbSend(
    `${title}\n<b>${esc(p.ad.ad_name ?? p.ad.ad_id)}</b>\nTài khoản ${esc(p.ad.account_name)} (${p.ad.account_id}) — chiến dịch ${esc(p.ad.campaign_name ?? "-")}\n${esc(p.reason)}`,
    fbButtons(data.id)
  );
  if (msgId) await db().from("fb_proposals").update({ message_id: msgId }).eq("id", data.id);
  return true;
}

export async function fbReportJob(day = shiftDay(vnDate(), -1)) {
  if (await isStopped()) return { skipped: "stopped" };
  const { rows, errors } = await collectDay(day);
  const rules = loadRules();
  const week = await loadHistory(shiftDay(day, -6), day).catch(() => rows);
  const stock = await loadStock();
  let text = morningText(day, rows, errors, week, stock);
  // Thứ Hai: kèm lý do anh bỏ qua đề xuất tuần qua.
  if (new Date(`${vnDate()}T00:00:00Z`).getUTCDay() === 1) {
    const why = await weeklyWhyLines("facebook").catch(() => []);
    if (why.length) text += ["", "", ...why].join("\n");
  }
  await fbSend(text);
  const history = week.filter((r) => r.ngay >= shiftDay(day, -(rules.scaleDays - 1)));
  let proposed = 0;
  for (const p of scaleCandidates(history, day, rules).slice(0, 5)) if (await propose(p, day)) proposed++;
  return { day, ads: rows.length, errors, proposed };
}

export async function fbWatchJob() {
  if (await isStopped()) return { skipped: "stopped" };
  const day = vnDate();
  const accounts = await listAccounts();
  let alerts = 0;
  for (const a of accounts) {
    if (a.status !== 1) {
      const ok = await fbAlertOnce(
        `acct:${a.id}:${a.status}`,
        `🚨 Tài khoản <b>${esc(a.name)}</b> (${a.id}) ${esc(ACCOUNT_STATUS[a.status] ?? `trạng thái ${a.status}`)}.`,
        24 * 60
      );
      if (ok) alerts++;
    }
  }
  // Ban đêm ít đơn, không đánh giá 0 đơn.
  if (vnHour() < 9) return { day, alerts };
  const { rows, errors } = await collectDay(
    day,
    accounts.filter((a) => a.status === 1)
  );
  let proposed = 0;
  for (const p of pauseCandidates(rows, loadRules()).slice(0, 5)) if (await propose(p, day)) proposed++;
  return { day, ads: rows.length, errors, alerts, proposed };
}

/** Đề xuất quá hạn này thì không làm nữa (số đã cũ). */
const PROPOSAL_TTL_HOURS = 20;

const STATUS_TEXT: Record<string, string> = {
  approved: "được anh đồng ý",
  executed: "đã làm",
  failed: "lỗi",
  rejected: "bỏ qua",
  expired: "hết hạn",
};

/**
 * Bấm nút. Đồng ý = làm ngay trên Meta (tắt quảng cáo / tăng ngân sách ngày), có kiểm tra lại trạng thái
 * thật trước khi làm. /stop chặn mọi thao tác.
 */
export async function fbDecide(id: number, approve: boolean): Promise<string> {
  const { data: p } = await db().from("fb_proposals").select("*").eq("id", id).maybeSingle();
  if (!p) return "Không tìm thấy đề xuất";
  if (p.status !== "proposed") return `Đề xuất này đã ${STATUS_TEXT[p.status] ?? p.status}`;
  const title = p.kind === "pause" ? "⏸ Đề xuất TẮT quảng cáo" : "📈 Đề xuất TĂNG ngân sách";
  const head = `${title}\n<b>${esc(p.ad_name ?? p.ad_id)}</b>\nTài khoản ${esc(p.account_name)} — ${esc(p.reason)}\n\n`;
  const finish = async (fields: Record<string, unknown>, note: string, answer: string) => {
    await db()
      .from("fb_proposals")
      .update({ ...fields, decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "proposed");
    if (p.message_id) await fbEdit(p.message_id, head + note);
    return answer;
  };

  if (!approve) return finish({ status: "rejected" }, "✖️ Anh bỏ qua.", "Đã bỏ qua");
  if (Date.now() - Date.parse(p.created_at) > PROPOSAL_TTL_HOURS * 3600_000)
    return finish({ status: "expired" }, "⌛ Đề xuất đã cũ, em không làm. Lần quét sau sẽ đề xuất lại nếu vẫn cần.", "Đề xuất đã hết hạn");
  if (await isStopped()) return "Đang dừng khẩn cấp (/release để chạy lại)";
  // Giai đoạn 1 (anh chốt 13/11): chỉ báo cáo + đề xuất; Đồng ý = ghi nhận, người chạy QC làm tay.
  if (process.env.FB_EXECUTE !== "1")
    return finish(
      { status: "approved" },
      "✅ Anh đồng ý. Giai đoạn này Kiều Trang chưa tự thao tác trên Meta: người chạy quảng cáo làm tay giúp.",
      "Đã ghi nhận"
    );

  try {
    const state = await adState(p.ad_id);
    if (p.kind === "pause") {
      if (state.effective_status !== "ACTIVE")
        return finish(
          { status: "executed", target_level: "ad", target_id: p.ad_id, before: { status: state.effective_status } },
          `ℹ️ Quảng cáo đang ở trạng thái ${esc(state.effective_status)}, không cần tắt.`,
          "Quảng cáo không còn chạy"
        );
      await pauseAd(p.ad_id);
      return finish(
        { status: "executed", target_level: "ad", target_id: p.ad_id, before: { status: "ACTIVE" }, after: { status: "PAUSED" } },
        "✅ Đã TẮT quảng cáo trên Meta.",
        "Đã tắt quảng cáo"
      );
    }
    const target = budgetTarget(state);
    if (!target)
      return finish({ status: "failed", error: "Không có ngân sách ngày" }, "⚠️ Quảng cáo dùng ngân sách trọn đời, em không tự tăng. Anh chỉnh tay giúp.", "Không tăng được");
    // Hai quảng cáo cùng nhóm/chiến dịch: chỉ tăng một lần mỗi ngày.
    const { data: done } = await db()
      .from("fb_proposals")
      .select("id")
      .eq("status", "executed")
      .eq("kind", "scale")
      .eq("target_id", target.id)
      .gte("decided_at", new Date(Date.now() - 20 * 3600_000).toISOString())
      .limit(1);
    if (done?.length)
      return finish({ status: "rejected", error: "Đã tăng hôm nay" }, "ℹ️ Ngân sách này vừa được tăng hôm nay (qua quảng cáo khác cùng nhóm), em không tăng thêm.", "Đã tăng trước đó");
    const rules = loadRules();
    const next = scaledBudget(target.daily, rules.scaleStep, rules.maxScaleIncrease);
    await setDailyBudget(target.id, next);
    const where = target.level === "adset" ? "nhóm quảng cáo" : "chiến dịch";
    return finish(
      { status: "executed", target_level: target.level, target_id: target.id, before: { daily_budget: target.daily }, after: { daily_budget: next } },
      `✅ Đã tăng ngân sách ngày của ${where}: ${vnd(target.daily)} → <b>${vnd(next)}</b>.`,
      "Đã tăng ngân sách"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finish({ status: "failed", error: msg.slice(0, 500) }, `⚠️ Lỗi khi làm trên Meta: <code>${esc(msg.slice(0, 300))}</code>`, "Lỗi, xem tin nhắn");
  }
}

/** /status: số hôm nay đến giờ (đọc trực tiếp, không ghi đề xuất). */
export async function fbStatusText(): Promise<string> {
  const day = vnDate();
  const { rows, errors } = await collectDay(day);
  const { count } = await db().from("fb_proposals").select("id", { count: "exact", head: true }).eq("status", "proposed");
  const stopped = await isStopped();
  return [
    morningText(day, rows, errors).replace("📘 <b>Facebook", "📘 <b>Facebook hôm nay"),
    count ? `\n💡 ${count} đề xuất đang chờ duyệt` : "",
    stopped ? "\n🛑 Đang dừng (/release để chạy lại)" : "",
  ].join("");
}

/** Chạy 1 lần sau khi đặt token: nối webhook, lệnh, gửi tin chào vào chủ đề Facebook. */
export async function fbSetupJob() {
  const base =
    process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  if (!base) return { ok: false, error: "Không biết địa chỉ máy chủ (APP_URL)" };
  const r = await fbSetupWebhook(base);
  const hello = r.ok
    ? await fbSend("👋 Chào anh, em là <b>Kiều Trang</b>, nhân viên Facebook. Sáng 8:05 em báo hiệu quả quảng cáo, lãi/lỗ, content hiệu quả và đề xuất. Gõ /help để xem lệnh.")
    : null;
  return { ...r, hello: hello != null };
}
