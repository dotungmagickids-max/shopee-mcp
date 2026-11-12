/**
 * Nhân viên Facebook — job chạy theo lịch (pg_cron → /api/jobs/fb-*):
 *   fb-report  08:00  thu số hôm qua, báo sáng, đề xuất tăng ngân sách
 *   fb-watch   mỗi giờ 9h–23h  thu số hôm nay, cảnh báo quảng cáo chi nhiều mà 0 đơn, tài khoản lỗi
 * Giai đoạn 1: chỉ báo cáo và đề xuất. Bấm Đồng ý chỉ ghi nhận, không thao tác trên Meta.
 */
import { db } from "../supabase";
import { esc, vnd } from "../autopilot/telegram";
import { vnDate, vnHour } from "../autopilot/time";
import { ACCOUNT_STATUS, adInsights, listAccounts, type MetaAccount } from "./meta";
import { ordersByAd } from "./orders";
import {
  loadRules,
  outcome,
  pauseCandidates,
  rankAds,
  ratio,
  realSpend,
  scaleCandidates,
  shiftDay,
  sumByAccount,
  type AdDay,
  type Proposal,
} from "./rules";
import { fbAlertOnce, fbButtons, fbEdit, fbSend } from "./telegram";

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
        const o = orders.get(r.ad_id) ?? { orders: 0, revenue: 0 };
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
  return (data ?? []).map((r: any) => ({ ...r, spend: Number(r.spend), revenue: Number(r.revenue), meta_purchase_value: Number(r.meta_purchase_value) }));
}

const pct = (q: number | null) => (q == null ? "∞" : `${Math.round(q * 100)}%`);

function adLine(a: AdDay): string {
  const o = outcome(a);
  return `• ${esc(a.ad_name ?? a.ad_id)} — <i>${esc(a.account_name)} / ${esc(a.campaign_name ?? "-")}</i>\n  chi ${vnd(realSpend(a.spend))}, ${o.orders} đơn, ${vnd(o.revenue)} → ${pct(ratio(a))}`;
}

/** Nội dung báo sáng (hàm thuần trên số đã thu). */
export function morningText(day: string, rows: AdDay[], errors: string[] = []): string {
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
  const lines = [
    `📘 <b>Facebook ${day.split("-").reverse().join("/")}</b>`,
    `Chi thật ${vnd(t.spendReal)} — ${t.orders} đơn — ${vnd(t.revenue)} → <b>${pct(t.ratio)}</b> (mục tiêu &lt; ${Math.round(rules.targetRatio * 100)}%)`,
    "",
    "<b>Theo tài khoản</b>",
    ...pancake.map((a) => `• ${esc(a.account_name)} (${a.account_id}): ${vnd(a.spendReal)}, ${a.orders} đơn, ${pct(a.ratio)}`),
  ];
  if (cpas.length) {
    const c = tot(cpas);
    lines.push("", `<b>CPAS → Shopee</b> (số mua Meta ghi nhận): chi ${vnd(c.spendReal)}, ${c.orders} đơn, ${vnd(c.revenue)} → ${pct(c.ratio)}`);
  }
  const { best, worst } = rankAds(rows, rules);
  if (best.length) lines.push("", "✅ <b>Tốt nhất</b>", ...best.map(adLine));
  if (worst.length) lines.push("", "⚠️ <b>Kém nhất</b>", ...worst.map(adLine));
  if (errors.length) lines.push("", `Không đọc được: ${esc(errors.join("; ").slice(0, 500))}`);
  return lines.join("\n");
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
  await fbSend(morningText(day, rows, errors));
  const rules = loadRules();
  const history = await loadHistory(shiftDay(day, -(rules.scaleDays - 1)), day);
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

/** Bấm nút. Giai đoạn 1: chỉ ghi quyết định. */
export async function fbDecide(id: number, approve: boolean): Promise<string> {
  const { data: p } = await db().from("fb_proposals").select("*").eq("id", id).maybeSingle();
  if (!p) return "Không tìm thấy đề xuất";
  if (p.status !== "proposed") return `Đề xuất đã ${p.status === "approved" ? "được duyệt" : "bỏ qua"} trước đó`;
  const status = approve ? "approved" : "rejected";
  await db().from("fb_proposals").update({ status, decided_at: new Date().toISOString() }).eq("id", id);
  if (p.message_id) {
    const note = approve
      ? "✅ Anh đã đồng ý. Giai đoạn này em chưa tự thao tác trên Meta: người chạy quảng cáo làm tay giúp."
      : "✖️ Anh bỏ qua.";
    const title = p.kind === "pause" ? "⏸ Đề xuất TẮT quảng cáo" : "📈 Đề xuất TĂNG ngân sách";
    await fbEdit(p.message_id, `${title}\n<b>${esc(p.ad_name ?? p.ad_id)}</b>\nTài khoản ${esc(p.account_name)} — ${esc(p.reason)}\n\n${note}`);
  }
  return approve ? "Đã ghi nhận đồng ý" : "Đã bỏ qua";
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
