import { db } from "../supabase";
import { isDryRun, shopName } from "./config";
import { automationBlocked, autoRunnable, dailyCap, editsLimit, increaseLimit, loadSettings, SALE_TIER_VI, saleTier, type ShopSettings } from "./settings";
import { callShopee, ShopeeCallError } from "./shopee-call";
import { CLASS_VI, type ProductClass } from "./classes";
import { setProductClass } from "./profit";
import { approveButtons, editTelegram, esc, sendAlertOnce, sendTelegram, sendTelegramMessage, sendTelegramPhoto, vnd } from "./telegram";
import { apiDate, vnDate, vnDayStartUnix } from "./time";

export type ActionKind = "change_budget" | "change_roas_target" | "pause" | "resume" | "refresh" | "launch" | "set_class";

/** Tạo chiến dịch GMV Max theo sản phẩm (đặt giá thầu tự động). */
export const CREATE_ENDPOINT = "ads.create_manual_product_ads";

/** Endpoint sửa chiến dịch sản phẩm (GMV Max theo sản phẩm: ad_type "manual", bidding auto). */
export const EDIT_ENDPOINT = "ads.edit_manual_product_ads";

export interface ProposalInput {
  shop_id: number;
  campaign_id: number | null; // null khi lên quảng cáo sản phẩm chưa có chiến dịch
  action: ActionKind;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  source: string; // 'rule:scale_up', 'admin', 'telegram', ...
}

export interface ActionRow {
  id: number;
  shop_id: number;
  campaign_id: number | null;
  action: string;
  before: any;
  after: any;
  reason: string | null;
  source: string;
  reference_id: string;
  status: string;
  error: string | null;
  parent_id: number | null;
  expires_at: string | null;
  telegram_message_id: number | null;
  decided_by?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Mô tả
// ---------------------------------------------------------------------------

async function campaignName(shopId: number, campaignId: number | null): Promise<string> {
  if (!campaignId) return "";
  const { data } = await db()
    .from("ads_campaigns")
    .select("ad_name")
    .eq("shop_id", shopId)
    .eq("campaign_id", campaignId)
    .maybeSingle();
  return data?.ad_name ?? "";
}

/**
 * Ảnh đại diện sản phẩm của chiến dịch (sản phẩm đầu tiên). Lấy từ Shopee lần đầu rồi lưu vào
 * ads_campaigns.image_url. Lỗi thì trả null (đề xuất vẫn gửi bằng chữ).
 */
export async function campaignImage(shopId: number, campaignId: number | null): Promise<string | null> {
  if (!campaignId) return null;
  try {
    const { data } = await db()
      .from("ads_campaigns")
      .select("image_url, item_ids")
      .eq("shop_id", shopId)
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (data?.image_url) return data.image_url;
    const itemId = Number(data?.item_ids?.[0]);
    if (!itemId) return null;
    const res = await callShopee(shopId, "product.get_item_base_info", { item_id_list: String(itemId) });
    const url: string | undefined = res.response?.item_list?.[0]?.image?.image_url_list?.[0];
    if (!url) return null;
    await db().from("ads_campaigns").update({ image_url: url }).eq("shop_id", shopId).eq("campaign_id", campaignId);
    return url;
  } catch {
    return null;
  }
}

export function describeChange(action: string, before: any, after: any): string {
  switch (action) {
    case "change_budget":
      return `Ngân sách ${before?.budget === 0 ? "không giới hạn" : vnd(before?.budget)} → <b>${vnd(after?.budget)}</b>`;
    case "change_roas_target":
      return `ROAS mục tiêu ${before?.roas_target ?? "-"} → <b>${after?.roas_target}</b>`;
    case "pause":
      return `<b>Tạm dừng</b>${after?.until_midnight ? " tới 0h" : ""}`;
    case "resume":
      return `<b>Bật lại</b>`;
    case "refresh":
      return `<b>Làm mới</b>: dừng hẳn, tạo chiến dịch mới NS ${vnd(after?.budget)}, ROAS ${after?.roas_target ?? "-"}${
        after?.why ? ` <i>(${esc(after.why)})</i>` : ""
      }${after?.new_campaign_id ? ` → #${after.new_campaign_id}` : ""}`;
    case "launch":
      return `<b>Lên quảng cáo</b> GMV Max: ngân sách ${vnd(after?.budget)}/ngày, ROAS mục tiêu ${after?.roas_target ?? "-"}${
        after?.new_campaign_id ? ` → #${after.new_campaign_id}` : ""
      }`;
    case "set_class":
      return `Nhóm hàng ${CLASS_VI[before?.cls as ProductClass] ?? before?.cls ?? "-"} → <b>${CLASS_VI[after?.cls as ProductClass] ?? after?.cls}</b>`;
    default:
      return action;
  }
}

const STATUS_VI: Record<string, string> = {
  executed: "✅ Đã thực hiện",
  dry_run: "🧪 Dry-run (chưa gửi Shopee)",
  failed: "❌ Lỗi",
  skipped: "⏭ Bỏ qua",
  rejected: "✖️ Đã bỏ qua",
  expired: "⌛ Hết hạn",
  approved: "Đã duyệt",
  proposed: "Chờ duyệt",
};

async function proposalText(row: ActionRow, children?: ActionRow[]): Promise<string> {
  const head = `<b>${esc(shopName(row.shop_id))}</b> (${row.shop_id})`;
  if (children) {
    const lines = await Promise.all(
      children.slice(0, 25).map(async (c) => {
        const name = (await campaignName(c.shop_id, c.campaign_id)).slice(0, 40);
        return `• ${esc(name)} #${c.campaign_id}: ${describeChange(c.action, c.before, c.after)}${
          c.status !== "proposed" ? ` — ${STATUS_VI[c.status] ?? c.status}` : ""
        }`;
      })
    );
    if (children.length > 25) lines.push(`… và ${children.length - 25} chiến dịch khác (xem dashboard)`);
    return `📋 <b>${esc(row.after?.title ?? row.action)}</b>\n${head}\n${esc(row.reason ?? "")}\n\n${lines.join("\n")}`;
  }
  const name = row.campaign_id ? await campaignName(row.shop_id, row.campaign_id) : String(row.after?.name ?? "");
  const ref = row.campaign_id ? ` #${row.campaign_id}` : row.after?.item_id ? ` (sản phẩm ${row.after.item_id})` : "";
  return `💡 <b>Đề xuất</b> — ${head}\n${esc(name)}${ref}\n${describeChange(row.action, row.before, row.after)}\nLý do: ${esc(row.reason ?? "")}`;
}

// ---------------------------------------------------------------------------
// Tạo đề xuất
// ---------------------------------------------------------------------------

/** Có đề xuất đang chờ hoặc thay đổi gần đây cho chiến dịch này không (cooldown). */
export async function recentlyTouched(shopId: number, campaignId: number, cooldownMinutes: number): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const { data } = await db()
    .from("autopilot_actions")
    .select("id, status, created_at, expires_at")
    .eq("shop_id", shopId)
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(5);
  return (data ?? []).some(
    (r) =>
      (r.status === "proposed" && (!r.expires_at || Date.parse(r.expires_at) > Date.now())) ||
      (["executed", "dry_run", "approved"].includes(r.status) && r.created_at >= since)
  );
}

export async function editsToday(shopId: number, campaignId: number): Promise<number> {
  const start = new Date(vnDayStartUnix(vnDate()) * 1000).toISOString();
  const { count } = await db()
    .from("autopilot_actions")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("campaign_id", campaignId)
    .in("status", ["executed", "dry_run"])
    .gte("executed_at", start);
  return count ?? 0;
}

/**
 * Tạo một đề xuất. Chế độ auto (và nguồn là luật) thì thực thi luôn; còn lại gửi Telegram có nút duyệt.
 */
export async function propose(input: ProposalInput, ttlMinutes: number, settings?: ShopSettings): Promise<ActionRow> {
  const s = settings ?? (await loadSettings(input.shop_id));
  const { data, error } = await db()
    .from("autopilot_actions")
    .insert({
      ...input,
      status: "proposed",
      expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    })
    .select("*")
    .single();
  if (error) throw new Error(`autopilot_actions: ${error.message}`);
  const row = data as ActionRow;
  // Tự chạy: chế độ auto, hoặc việc tăng ngân sách anh đã cho tự chạy (tóm tắt trong báo cáo 8h).
  if ((s.mode === "auto" && input.source.startsWith("rule:")) || autoRunnable(s, input.source, input.action, input.before, input.after)) {
    await decide(row.id, true, "auto");
    return row;
  }
  const image = row.campaign_id ? await campaignImage(row.shop_id, row.campaign_id) : (row.after?.image as string | undefined) ?? null;
  const msgId = await sendTelegramPhoto(image, await proposalText(row), {
    replyMarkup: approveButtons(row.id),
  });
  if (msgId) await db().from("autopilot_actions").update({ telegram_message_id: msgId }).eq("id", row.id);
  return row;
}

/** Đề xuất nhóm: một dòng cha (một tin Telegram) + nhiều dòng con. */
export async function proposeGroup(
  shopId: number,
  title: string,
  items: Omit<ProposalInput, "shop_id" | "source" | "reason">[],
  source: string,
  reason: string,
  ttlMinutes: number,
  opts: { autoExecute?: boolean } = {}
): Promise<ActionRow | null> {
  if (!items.length) return null;
  const expires_at = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const { data: parent, error } = await db()
    .from("autopilot_actions")
    .insert({
      shop_id: shopId,
      action: "group",
      after: { title, count: items.length },
      reason,
      source,
      status: "proposed",
      expires_at,
    })
    .select("*")
    .single();
  if (error) throw new Error(`autopilot_actions: ${error.message}`);
  const { data: children, error: e2 } = await db()
    .from("autopilot_actions")
    .insert(items.map((i) => ({ ...i, shop_id: shopId, source, reason, status: "proposed", parent_id: parent.id, expires_at })))
    .select("*");
  if (e2) throw new Error(`autopilot_actions: ${e2.message}`);
  if (opts.autoExecute) {
    await decide(parent.id, true, "auto");
    return parent as ActionRow;
  }
  const msgId = await sendTelegramMessage(await proposalText(parent as ActionRow, children as ActionRow[]), {
    replyMarkup: approveButtons(parent.id),
  });
  if (msgId) await db().from("autopilot_actions").update({ telegram_message_id: msgId }).eq("id", parent.id);
  return parent as ActionRow;
}

// ---------------------------------------------------------------------------
// Duyệt và thực thi
// ---------------------------------------------------------------------------

/**
 * Duyệt / bỏ qua một đề xuất (đơn hoặc nhóm). Chuyển trạng thái nguyên tử proposed → approved,
 * nên bấm 2 lần hoặc duyệt cùng lúc trên web và Telegram cũng chỉ thực thi một lần.
 */
export async function decide(id: number, approve: boolean, by: string): Promise<{ ok: boolean; message: string }> {
  const nowIso = new Date().toISOString();
  const { data: current } = await db().from("autopilot_actions").select("*").eq("id", id).maybeSingle();
  if (!current) return { ok: false, message: "Không tìm thấy đề xuất" };
  if (current.status !== "proposed") return { ok: false, message: `Đề xuất đã xử lý (${STATUS_VI[current.status] ?? current.status})` };
  if (approve && current.expires_at && Date.parse(current.expires_at) < Date.now()) {
    await db().from("autopilot_actions").update({ status: "expired", decided_at: nowIso }).eq("id", id).eq("status", "proposed");
    await db().from("autopilot_actions").update({ status: "expired", decided_at: nowIso }).eq("parent_id", id).eq("status", "proposed");
    await refreshMessage(id);
    return { ok: false, message: "Đề xuất đã hết hạn (số liệu cũ). Chờ đề xuất mới." };
  }
  const { data: claimed } = await db()
    .from("autopilot_actions")
    .update({ status: approve ? "approved" : "rejected", decided_at: nowIso, decided_by: by })
    .eq("id", id)
    .eq("status", "proposed")
    .select("*");
  if (!claimed?.length) return { ok: false, message: "Đề xuất đã được xử lý ở nơi khác" };

  let rows: ActionRow[] = [];
  if (current.action === "group") {
    const { data: kids } = await db()
      .from("autopilot_actions")
      .update({ status: approve ? "approved" : "rejected", decided_at: nowIso, decided_by: by })
      .eq("parent_id", id)
      .eq("status", "proposed")
      .select("*");
    rows = (kids ?? []) as ActionRow[];
  } else {
    rows = claimed as ActionRow[];
  }

  let message = approve ? "Đã duyệt" : "Đã bỏ qua";
  if (approve) {
    const results = [];
    for (const r of rows) {
      const res = await execute(r);
      results.push(res);
      if (res.halted) break;
    }
    const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    message = Object.entries(counts).map(([k, v]) => `${STATUS_VI[k] ?? k}: ${v}`).join(", ") || "Không có thay đổi";
    if (current.action === "group") {
      await db().from("autopilot_actions").update({ status: "executed", executed_at: nowIso }).eq("id", id);
    }
  }
  await refreshMessage(id);
  return { ok: true, message };
}

async function refreshMessage(id: number) {
  const { data: row } = await db().from("autopilot_actions").select("*").eq("id", id).maybeSingle();
  if (!row?.telegram_message_id) return;
  let text: string;
  if (row.action === "group") {
    const { data: kids } = await db().from("autopilot_actions").select("*").eq("parent_id", id).order("id");
    text = await proposalText(row as ActionRow, (kids ?? []) as ActionRow[]);
  } else {
    text = `${await proposalText(row as ActionRow)}\n\n${STATUS_VI[row.status] ?? row.status}${row.error ? `: ${esc(row.error)}` : ""}`;
  }
  if (row.action === "group") text += `\n\n${row.status === "rejected" ? "✖️ Đã bỏ qua" : row.status === "expired" ? "⌛ Hết hạn" : "Đã xử lý"}`;
  await editTelegram(row.telegram_message_id, text);
}

/** Áp trần cứng cho ngân sách mới. Trả về ngân sách được phép hoặc lý do bỏ qua. */
export async function guardBudget(
  s: ShopSettings,
  campaignId: number,
  current: number,
  wanted: number,
  fast = false
): Promise<{ budget: number | null; note: string }> {
  let budget = Math.round(wanted / 1000) * 1000;
  const notes: string[] = [];
  const maxInc = increaseLimit(s, vnDate(), fast);
  if (current > 0 && budget > current * (1 + maxInc / 100)) {
    budget = Math.floor((current * (1 + maxInc / 100)) / 1000) * 1000;
    notes.push(`giới hạn tăng ${maxInc}%`);
  }
  if (s.campaign_cap && budget > s.campaign_cap) {
    budget = s.campaign_cap;
    notes.push(`trần chiến dịch ${vnd(s.campaign_cap)}`);
  }
  const cap = dailyCap(s);
  if (cap) {
    const { data } = await db()
      .from("ads_campaigns")
      .select("campaign_id, campaign_budget")
      .eq("shop_id", s.shop_id)
      .eq("campaign_status", "ongoing");
    const others = (data ?? [])
      .filter((c) => Number(c.campaign_id) !== campaignId)
      .reduce((sum, c) => sum + Number(c.campaign_budget ?? 0), 0);
    if (others + budget > cap) {
      budget = Math.max(0, Math.floor((cap - others) / 1000) * 1000);
      notes.push(`cầu chì tổng/ngày ${vnd(cap)}`);
      // Cầu chì chỉ để chặn lỗi: chạm là báo anh ngay, không tự giảm gì.
      await sendAlertOnce(
        `fuse:${s.shop_id}:${vnDate()}`,
        `🔌 <b>Chạm cầu chì ngân sách</b> — ${esc(shopName(s.shop_id))}\nTổng ngân sách các chiến dịch sắp vượt ${vnd(cap)} (${SALE_TIER_VI[saleTier(s)]}). Tool dừng tăng thêm, không giảm gì.\nNếu vẫn đang lãi, anh nâng mức cầu chì trong Cài đặt.`,
        180
      );
    }
  }
  // 0 nghĩa là "không giới hạn" trên Shopee: không bao giờ để trần ép về 0.
  if (budget <= 0) return { budget: null, note: `Trần không cho phép: ${notes.join(", ")}` };
  if (budget > current && current > 0) return { budget, note: notes.join(", ") };
  if (budget <= current && wanted > current) return { budget: null, note: `Không tăng được: ${notes.join(", ")}` };
  return { budget, note: notes.join(", ") };
}

async function finish(row: ActionRow, status: string, error: string | null, after?: unknown) {
  await db()
    .from("autopilot_actions")
    .update({ status, error, executed_at: new Date().toISOString(), ...(after ? { after } : {}) })
    .eq("id", row.id);
  return status;
}

/** Thực thi một dòng đã duyệt. Luôn kiểm tra lại dừng khẩn cấp, trần, số lần chỉnh, dry-run. */
export async function execute(row: ActionRow): Promise<{ status: string; halted?: boolean }> {
  const s = await loadSettings(row.shop_id);
  const blocked = automationBlocked(s);
  if (blocked) return { status: await finish(row, "skipped", blocked) };
  if (row.action === "launch") return executeLaunch(row, s);
  if (!row.campaign_id) return { status: await finish(row, "skipped", "Thiếu campaign_id") };
  if (row.action === "set_class") {
    const cls = row.after?.cls as ProductClass;
    if (!CLASS_VI[cls]) return { status: await finish(row, "skipped", `Nhóm không hợp lệ: ${cls}`) };
    const n = await setProductClass(row.shop_id, row.campaign_id, cls);
    return { status: await finish(row, n > 0 ? "executed" : "skipped", n > 0 ? null : "Không tìm thấy sản phẩm của chiến dịch") };
  }

  const maxEdits = row.after?.fast ? Math.max(editsLimit(s), s.params.fast_max_edits_per_day) : editsLimit(s);
  if ((await editsToday(row.shop_id, row.campaign_id)) >= maxEdits) {
    return { status: await finish(row, "skipped", `Đã chỉnh ${maxEdits} lần hôm nay`) };
  }

  if (row.action === "refresh") return executeRefresh(row);

  // Shopee trả error_server khi sửa ngân sách/ROAS của chiến dịch đang tạm dừng (thử 11/11/2026).
  if (row.action === "change_budget" || row.action === "change_roas_target") {
    const { data: camp } = await db()
      .from("ads_campaigns")
      .select("campaign_status")
      .eq("shop_id", row.shop_id)
      .eq("campaign_id", row.campaign_id)
      .maybeSingle();
    if (camp?.campaign_status && camp.campaign_status !== "ongoing") {
      return { status: await finish(row, "skipped", "Chiến dịch không ở trạng thái đang chạy: Shopee không cho sửa") };
    }
  }

  const params: Record<string, unknown> = {
    reference_id: row.reference_id,
    campaign_id: row.campaign_id,
    edit_action: row.action,
  };
  let after = row.after;
  if (row.action === "change_budget") {
    const current = Number(row.before?.budget ?? 0);
    const g = await guardBudget(s, row.campaign_id, current, Number(row.after?.budget), !!row.after?.fast);
    if (g.budget == null) return { status: await finish(row, "skipped", g.note) };
    params.budget = g.budget;
    after = { ...row.after, budget: g.budget, ...(g.note ? { capped: g.note } : {}) };
  } else if (row.action === "change_roas_target") {
    const before = Number(row.before?.roas_target ?? 0);
    const wanted = Number(row.after?.roas_target);
    if (before > 0 && Math.abs(wanted - before) / before > 0.1501) {
      return { status: await finish(row, "skipped", "Đổi ROAS mục tiêu quá 15%") };
    }
    params.roas_target = Math.round(wanted * 10) / 10;
  } else if (!["pause", "resume"].includes(row.action)) {
    return { status: await finish(row, "skipped", `Hành động không hỗ trợ: ${row.action}`) };
  }

  if (isDryRun(row.action)) return { status: await finish(row, "dry_run", null, after) };

  try {
    await callShopee(row.shop_id, EDIT_ENDPOINT, params, { allowWrite: true });
  } catch (err) {
    const e = err instanceof ShopeeCallError ? err : new ShopeeCallError(String(err), "network");
    await finish(row, "failed", e.message.slice(0, 500), after);
    if (e.kind !== "api") {
      await halt(row.shop_id, `Lỗi ${e.kind} khi sửa chiến dịch #${row.campaign_id}: ${e.message.slice(0, 200)}`);
      return { status: "failed", halted: true };
    }
    return { status: "failed" };
  }

  // Cập nhật bản sao cục bộ để luật lần sau dùng số mới.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (row.action === "change_budget") {
    patch.campaign_budget = params.budget;
    if (row.after?.throttle) {
      patch.throttled_at = new Date().toISOString();
      patch.restore_budget = row.after.restore_budget ?? null;
    } else if (row.after?.restore) {
      patch.throttled_at = null;
      patch.restore_budget = null;
    }
  }
  if (row.action === "change_roas_target") patch.roas_target = params.roas_target;
  if (row.action === "pause") {
    patch.campaign_status = "paused";
    if (row.after?.until_midnight) patch.tool_paused_at = new Date().toISOString();
  }
  if (row.action === "resume") {
    patch.campaign_status = "ongoing";
    patch.tool_paused_at = null;
  }
  await db().from("ads_campaigns").update(patch).eq("shop_id", row.shop_id).eq("campaign_id", row.campaign_id);
  await db().from("ads_campaign_history").insert({
    shop_id: row.shop_id,
    campaign_id: row.campaign_id,
    campaign_status: patch.campaign_status ?? null,
    campaign_budget: patch.campaign_budget ?? null,
    roas_target: patch.roas_target ?? null,
  });
  return { status: await finish(row, "executed", null, after) };
}

/**
 * Làm mới: dừng hẳn chiến dịch cũ (không hoàn tác được) rồi tạo chiến dịch GMV Max mới cho cùng sản phẩm.
 * Không bao giờ chạy ở chế độ auto: phải có người duyệt.
 */
async function executeRefresh(row: ActionRow): Promise<{ status: string; halted?: boolean }> {
  if (row.decided_by === "auto") return { status: await finish(row, "skipped", "Làm mới chiến dịch luôn cần anh duyệt") };
  const itemId = Number(row.after?.item_id);
  const budget = Number(row.after?.budget);
  if (!itemId || !(budget > 0)) return { status: await finish(row, "skipped", "Thiếu item_id hoặc ngân sách") };
  const { data: camp } = await db()
    .from("ads_campaigns")
    .select("campaign_status, ad_name")
    .eq("shop_id", row.shop_id)
    .eq("campaign_id", row.campaign_id)
    .maybeSingle();
  if (camp?.campaign_status !== "ongoing") {
    return { status: await finish(row, "skipped", "Chiến dịch không còn ở trạng thái đang chạy") };
  }
  if (isDryRun("refresh")) return { status: await finish(row, "dry_run", null) };

  // reference_id riêng cho lệnh tạo, lưu trước khi gửi để không bao giờ tạo trùng.
  const createRef = row.after?.create_reference_id ?? crypto.randomUUID();
  let after = { ...row.after, create_reference_id: createRef };
  await db().from("autopilot_actions").update({ after }).eq("id", row.id);

  if (!row.after?.stopped) {
    try {
      await callShopee(row.shop_id, EDIT_ENDPOINT, { reference_id: row.reference_id, campaign_id: row.campaign_id, edit_action: "stop" }, { allowWrite: true });
    } catch (err) {
      const e = err instanceof ShopeeCallError ? err : new ShopeeCallError(String(err), "network");
      await finish(row, "failed", `Dừng chiến dịch cũ lỗi: ${e.message.slice(0, 400)}`, after);
      if (e.kind !== "api") {
        await halt(row.shop_id, `Lỗi ${e.kind} khi dừng chiến dịch #${row.campaign_id}`);
        return { status: "failed", halted: true };
      }
      return { status: "failed" };
    }
    after = { ...after, stopped: true };
    await db().from("autopilot_actions").update({ after }).eq("id", row.id);
    await db().from("ads_campaigns").update({ campaign_status: "ended", updated_at: new Date().toISOString() }).eq("shop_id", row.shop_id).eq("campaign_id", row.campaign_id);
  }

  let newId: number | null = null;
  try {
    const params: Record<string, unknown> = {
      reference_id: createRef,
      budget,
      start_date: apiDate(vnDate()),
      bidding_method: "auto",
      item_id: itemId,
    };
    if (row.after?.roas_target) params.roas_target = Number(row.after.roas_target);
    const res = await callShopee(row.shop_id, CREATE_ENDPOINT, params, { allowWrite: true });
    const r = Array.isArray(res.response) ? res.response[0] : res.response;
    newId = r?.campaign_id ? Number(r.campaign_id) : null;
  } catch (err) {
    const e = err instanceof ShopeeCallError ? err : new ShopeeCallError(String(err), "network");
    await finish(row, "failed", `ĐÃ DỪNG chiến dịch cũ nhưng TẠO MỚI LỖI: ${e.message.slice(0, 300)}`, after);
    await sendTelegram(
      `🚨 <b>Sản phẩm đang không có quảng cáo</b> — ${esc(shopName(row.shop_id))}\n${esc(camp?.ad_name ?? "")}\nĐã dừng chiến dịch #${row.campaign_id} nhưng tạo chiến dịch mới lỗi:\n<code>${esc(e.message.slice(0, 300))}</code>\nAnh tạo lại trên Shopee giúp em.`
    );
    if (e.kind !== "api") {
      await halt(row.shop_id, `Lỗi ${e.kind} khi tạo chiến dịch mới cho sản phẩm ${itemId}`);
      return { status: "failed", halted: true };
    }
    return { status: "failed" };
  }

  after = { ...after, new_campaign_id: newId };
  if (newId) {
    await db().from("ads_campaigns").upsert({
      shop_id: row.shop_id,
      campaign_id: newId,
      ad_type: "manual",
      ad_name: camp?.ad_name ?? null,
      bidding_method: "auto",
      campaign_placement: "all",
      campaign_status: "ongoing",
      campaign_budget: budget,
      roas_target: row.after?.roas_target ?? null,
      item_ids: [itemId],
      start_time: Math.floor(Date.now() / 1000),
      updated_at: new Date().toISOString(),
    });
  }
  return { status: await finish(row, "executed", null, after) };
}

/**
 * Lên quảng cáo: tạo chiến dịch GMV Max (đặt giá thầu tự động) cho một sản phẩm chưa có chiến dịch.
 * Luôn cần người duyệt. Chạy thật khi AUTOPILOT_LIVE_ACTIONS có "launch" hoặc tham số launch_live = 1.
 */
async function executeLaunch(row: ActionRow, s: ShopSettings): Promise<{ status: string; halted?: boolean }> {
  if (row.decided_by === "auto") return { status: await finish(row, "skipped", "Lên quảng cáo luôn cần anh duyệt") };
  const itemId = Number(row.after?.item_id);
  const budget = Number(row.after?.budget);
  if (!itemId || !(budget > 0)) return { status: await finish(row, "skipped", "Thiếu item_id hoặc ngân sách") };
  const { data: existing } = await db()
    .from("ads_campaigns")
    .select("campaign_id")
    .eq("shop_id", row.shop_id)
    .in("campaign_status", ["ongoing", "paused", "scheduled"])
    .contains("item_ids", [itemId]);
  if (existing?.length) return { status: await finish(row, "skipped", `Sản phẩm đã có chiến dịch #${existing[0].campaign_id}`) };
  if (isDryRun("launch") && !s.params.launch_live) return { status: await finish(row, "dry_run", null) };

  let newId: number | null = null;
  try {
    const params: Record<string, unknown> = {
      reference_id: row.reference_id,
      budget,
      start_date: apiDate(vnDate()),
      bidding_method: "auto",
      item_id: itemId,
    };
    if (row.after?.roas_target) params.roas_target = Math.round(Number(row.after.roas_target) * 10) / 10;
    const res = await callShopee(row.shop_id, CREATE_ENDPOINT, params, { allowWrite: true });
    const r = Array.isArray(res.response) ? res.response[0] : res.response;
    newId = r?.campaign_id ? Number(r.campaign_id) : null;
  } catch (err) {
    const e = err instanceof ShopeeCallError ? err : new ShopeeCallError(String(err), "network");
    await finish(row, "failed", e.message.slice(0, 500));
    if (e.kind !== "api") {
      await halt(row.shop_id, `Lỗi ${e.kind} khi tạo chiến dịch cho sản phẩm ${itemId}`);
      return { status: "failed", halted: true };
    }
    return { status: "failed" };
  }
  if (newId) {
    await db().from("ads_campaigns").upsert({
      shop_id: row.shop_id,
      campaign_id: newId,
      ad_type: "manual",
      ad_name: row.after?.name ?? null,
      bidding_method: "auto",
      campaign_placement: "all",
      campaign_status: "ongoing",
      campaign_budget: budget,
      roas_target: row.after?.roas_target ?? null,
      item_ids: [itemId],
      image_url: row.after?.image ?? null,
      start_time: Math.floor(Date.now() / 1000),
      updated_at: new Date().toISOString(),
    });
  }
  return { status: await finish(row, "executed", null, { ...row.after, new_campaign_id: newId }) };
}

/** Thay đổi anh tự làm trên dashboard: ghi nhật ký rồi thực thi ngay (vẫn qua trần cứng và dry-run). */
export async function adminChange(input: ProposalInput): Promise<{ status: string; error: string | null }> {
  const { data, error } = await db()
    .from("autopilot_actions")
    .insert({ ...input, status: "approved", decided_at: new Date().toISOString(), decided_by: "admin" })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const res = await execute(data as ActionRow);
  const { data: row } = await db().from("autopilot_actions").select("status, error").eq("id", data.id).single();
  return { status: res.status, error: row?.error ?? null };
}

/** Lỗi nghiêm trọng: dừng tự động của shop và báo Telegram. Gỡ bằng /release hoặc nút trên dashboard. */
export async function halt(shopId: number, reason: string) {
  await db()
    .from("autopilot_settings")
    .update({ emergency_stop: true, halt_reason: reason, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId);
  await sendTelegram(
    `🛑 <b>Autopilot tự dừng</b> — ${esc(shopName(shopId))}\n${esc(reason)}\nKiểm tra rồi gõ /release để chạy lại.`
  );
}

/** Hết hạn các đề xuất quá cũ (gọi trong job collect). */
export async function expireOld(): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data } = await db()
    .from("autopilot_actions")
    .update({ status: "expired", decided_at: nowIso })
    .eq("status", "proposed")
    .lt("expires_at", nowIso)
    .select("id, telegram_message_id");
  for (const r of data ?? []) if (r.telegram_message_id) await refreshMessage(r.id);
  return data?.length ?? 0;
}
