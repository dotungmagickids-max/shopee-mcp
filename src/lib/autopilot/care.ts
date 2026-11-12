/**
 * Nhân viên Shopee, giai đoạn A "giữ shop an toàn" (anh chốt 12/11/2026):
 *  - Vận đơn: đơn trễ hạn giao (Shopee tính điểm phạt), đơn sắp tới hạn.
 *  - Đánh giá: đánh giá ≤ 3 sao báo ngay kèm câu trả lời soạn sẵn (nút Gửi / Bỏ qua);
 *    đánh giá 4–5 sao gom lại 20h, một nút "trả lời cảm ơn tất cả".
 *  - Sức khỏe shop: chỉ số vượt ngưỡng, điểm phạt (báo sáng + cảnh báo).
 *  - Báo cáo tuần (thứ Hai).
 * Mọi lệnh ghi lên Shopee (trả lời đánh giá) chỉ chạy khi anh bấm duyệt.
 */
import { db } from "../supabase";
import { shops, type ShopConf } from "./config";
import { callShopee, chunk } from "./shopee-call";
import { editTelegram, esc, sendAlertOnce, sendTelegram, sendTelegramMessage } from "./telegram";
import { vnDate, vnHour } from "./time";

// ---------------------------------------------------------------------------
// Hàm thuần (test được)
// ---------------------------------------------------------------------------

/** Thời điểm (giây) từ số giây, mili giây, chuỗi ISO hoặc Date. */
export function toUnix(v: unknown): number {
  if (v == null || v === "") return 0;
  if (v instanceof Date) return v.getTime() / 1000;
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t / 1000 : 0;
  }
  const x = Number(v);
  return x > 1e11 ? x / 1000 : x;
}

export type ReviewTopic = "size" | "chat_luong" | "giao_hang" | "khac";

export const TOPIC_VI: Record<ReviewTopic, string> = {
  size: "size",
  chat_luong: "chất lượng",
  giao_hang: "giao hàng, thiếu/sai hàng",
  khac: "khác",
};

/** Đoán lý do chê từ nội dung đánh giá. */
export function reviewTopic(text: string): ReviewTopic {
  const t = text.toLowerCase();
  if (/size|chật|rộng|nhỏ quá|to quá|bé quá|dài quá|ngắn|không vừa|ko vừa|k vừa|cỡ/.test(t)) return "size";
  if (/thiếu|sai màu|sai mẫu|nhầm|giao chậm|ship chậm|lâu|đóng gói|móp|giao hàng/.test(t)) return "giao_hang";
  if (/chất|vải|xù|phai|bai|chỉ thừa|lỗi|rách|mỏng|nóng|bí|ra màu|hôi|mùi|không giống|ko giống/.test(t)) return "chat_luong";
  return "khac";
}

/** Câu trả lời soạn sẵn cho đánh giá ≤ 3 sao. Không hứa hoàn tiền; mời khách nhắn shop. */
export function lowReply(topic: ReviewTopic): string {
  const end = " Mẹ nhắn tin cho shop để Magickids hỗ trợ ngay ạ. Cảm ơn mẹ đã góp ý để shop làm tốt hơn!";
  switch (topic) {
    case "size":
      return "Magickids xin lỗi mẹ vì size chưa vừa với bé ạ. Shop hỗ trợ đổi size theo chiều cao, cân nặng của bé." + end;
    case "chat_luong":
      return "Magickids rất tiếc vì sản phẩm chưa làm mẹ hài lòng ạ. Shop sẽ kiểm tra lại lô hàng và hỗ trợ đổi sản phẩm cho mẹ." + end;
    case "giao_hang":
      return "Magickids xin lỗi mẹ vì sự cố khi nhận hàng ạ. Shop sẽ kiểm tra lại đơn và gửi bù/đổi cho mẹ." + end;
    default:
      return "Magickids xin lỗi vì trải nghiệm chưa tốt của mẹ ạ." + end;
  }
}

const THANKS = [
  "Magickids cảm ơn mẹ đã tin chọn shop ạ! Chúc bé mặc thật xinh và vui khỏe. Hẹn gặp lại mẹ ở đơn sau nhé!",
  "Cảm ơn mẹ đã ủng hộ Magickids ạ! Shop rất vui khi bé thích sản phẩm. Mẹ nhớ theo dõi shop để nhận ưu đãi mới nhé!",
  "Magickids cảm ơn đánh giá của mẹ ạ! Chúc gia đình mình luôn vui vẻ, bé lớn nhanh khỏe mạnh.",
  "Cảm ơn mẹ rất nhiều ạ! Magickids luôn cố gắng mang tới đồ đẹp, mặc thoải mái cho bé. Hẹn gặp lại mẹ!",
];

/** Lời cảm ơn cho đánh giá 4–5 sao, xoay vòng theo comment_id để không lặp y hệt. */
export function thankReply(commentId: string | number): string {
  const n = Number(String(commentId).slice(-4)) || 0;
  return THANKS[n % THANKS.length];
}

export type Metric = {
  metric_id: number;
  metric_name: string;
  current_period: number | null;
  unit: number;
  target: { value: number; comparator: string };
};

export const METRIC_VI: Record<string, string> = {
  late_shipment_rate: "Tỉ lệ giao trễ",
  non_fulfillment_rate: "Tỉ lệ đơn không thành công",
  preparation_time: "Thời gian chuẩn bị hàng",
  response_rate: "Tỉ lệ phản hồi chat",
  pre_order_listing_rate: "Tỉ lệ sản phẩm đặt trước",
  shop_rating: "Đánh giá shop",
  cancellation_rate: "Tỉ lệ hủy",
  return_refund_rate: "Tỉ lệ trả hàng/hoàn tiền",
  severe_listing_violations: "Vi phạm đăng bán nghiêm trọng",
  other_listing_violations: "Vi phạm đăng bán khác",
};

function passes(v: number, c: string, target: number): boolean {
  switch (c) {
    case "<":
      return v < target;
    case "<=":
      return v <= target;
    case ">":
      return v > target;
    case ">=":
      return v >= target;
    default:
      return true;
  }
}

/**
 * Chỉ số có vấn đề: không đạt mục tiêu ("vượt"), hoặc đã dùng ≥ 70% khoảng cho phép ("sát").
 * Chỉ xét chỉ số chính (có trong METRIC_VI) và có số.
 */
export function healthIssues(list: Metric[]): { name: string; value: number; target: string; level: "vuot" | "sat" }[] {
  const out: { name: string; value: number; target: string; level: "vuot" | "sat" }[] = [];
  for (const m of list) {
    const name = METRIC_VI[m.metric_name];
    const v = m.current_period;
    if (!name || v == null || !m.target) continue;
    const { value: t, comparator: c } = m.target;
    const unit = m.unit === 2 ? "%" : m.unit === 4 ? " ngày" : "";
    const target = `${c} ${t}${unit}`;
    if (!passes(v, c, t)) out.push({ name, value: v, target, level: "vuot" });
    else if ((c === "<" || c === "<=") && t > 0 && v >= 0.7 * t) out.push({ name, value: v, target, level: "sat" });
    else if ((c === ">" || c === ">=") && m.unit === 1 && v - t < 0.3) out.push({ name, value: v, target, level: "sat" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vận đơn
// ---------------------------------------------------------------------------

export async function lateOrders(shopId: number): Promise<{ order_sn: string; deadline: number; late_by_days: number }[]> {
  const out: { order_sn: string; deadline: number; late_by_days: number }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await callShopee(shopId, "account_health.get_late_orders", { page_no: page, page_size: 100 });
    const list = res.response?.late_order_list ?? [];
    for (const o of list) out.push({ order_sn: String(o.order_sn), deadline: toUnix(o.shipping_deadline), late_by_days: Number(o.late_by_days ?? 0) });
    if (list.length < 100) break;
  }
  return out;
}

/** Cảnh báo đơn trễ hạn giao (mỗi đơn tối đa 1 lần/12 giờ). */
async function scanLate(shop: ShopConf): Promise<number> {
  const late = await lateOrders(shop.shopId);
  if (!late.length) return 0;
  const sorted = late.sort((a, b) => b.late_by_days - a.late_by_days);
  const key = `care:late:${shop.shopId}:${sorted.map((o) => o.order_sn).sort().join(",").slice(0, 200)}`;
  const lines = sorted.slice(0, 15).map((o) => `• <code>${esc(o.order_sn)}</code> trễ ${o.late_by_days} ngày`);
  const sent = await sendAlertOnce(
    key,
    `🚚 <b>${esc(shop.name)}: ${late.length} đơn TRỄ HẠN GIAO</b>\nShopee sẽ tính điểm phạt, quá lâu thì tự hủy đơn.\n${lines.join("\n")}${late.length > 15 ? `\n… và ${late.length - 15} đơn khác` : ""}\n→ Kho kiểm tra và giao gấp.`,
    12 * 60
  );
  return sent ? late.length : 0;
}

// ---------------------------------------------------------------------------
// Đánh giá
// ---------------------------------------------------------------------------

type ReviewRow = {
  comment_id: string;
  shop_id: number;
  item_id: number;
  order_sn: string | null;
  rating: number;
  comment: string;
  create_time: string;
  replied: boolean;
};

/** Lấy đánh giá mới (tới khi gặp đánh giá đã lưu hoặc hết 5 trang). */
async function fetchNewReviews(shopId: number): Promise<ReviewRow[]> {
  const out: ReviewRow[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const res = await callShopee(shopId, "product.get_comment", { cursor, page_size: 100 });
    const list: any[] = res.response?.item_comment_list ?? [];
    const ids = list.map((c) => String(c.comment_id));
    const { data: known } = ids.length
      ? await db().from("shop_reviews").select("comment_id").in("comment_id", ids)
      : { data: [] as any[] };
    const knownSet = new Set((known ?? []).map((r: any) => String(r.comment_id)));
    for (const c of list) {
      if (knownSet.has(String(c.comment_id))) continue;
      out.push({
        comment_id: String(c.comment_id),
        shop_id: shopId,
        item_id: Number(c.item_id),
        order_sn: c.order_sn ? String(c.order_sn) : null,
        rating: Number(c.rating_star ?? 0),
        comment: String(c.comment ?? ""),
        create_time: new Date(toUnix(c.create_time) * 1000).toISOString(),
        replied: Boolean(c.comment_reply?.reply),
      });
    }
    // Cả trang đã biết: các trang sau cũ hơn, dừng.
    if (knownSet.size === list.length || !res.response?.more) break;
    cursor = String(res.response?.next_cursor ?? "");
    if (!cursor) break;
  }
  return out;
}

async function itemNames(shopId: number, itemIds: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  for (const part of chunk([...new Set(itemIds)], 50)) {
    const res = await callShopee(shopId, "product.get_item_base_info", { item_id_list: part.join(",") }).catch(() => null);
    for (const it of res?.response?.item_list ?? []) m.set(Number(it.item_id), String(it.item_name ?? ""));
  }
  return m;
}

function taskButtons(id: number) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Gửi trả lời", callback_data: `ca:${id}` },
        { text: "✖️ Bỏ qua", callback_data: `cr:${id}` },
      ],
    ],
  };
}

async function createTask(shopId: number, kind: "reply_low" | "reply_batch", payload: unknown): Promise<number> {
  const { data, error } = await db().from("shop_tasks").insert({ shop_id: shopId, kind, payload, status: "proposed" }).select("id").single();
  if (error || !data) throw new Error(`shop_tasks: ${error?.message ?? "không ghi được"}`);
  return data.id as number;
}

/** Đánh giá mới: lưu; ≤ 3 sao chưa trả lời → đề xuất trả lời ngay. Lần chạy đầu chỉ lưu, không báo. */
async function scanReviews(shop: ShopConf): Promise<{ new: number; low: number }> {
  const { count: before } = await db().from("shop_reviews").select("comment_id", { count: "exact", head: true }).eq("shop_id", shop.shopId);
  const fresh = await fetchNewReviews(shop.shopId);
  if (!fresh.length) return { new: 0, low: 0 };
  const rows = fresh.map((r) => ({ ...r, topic: r.rating <= 3 ? reviewTopic(r.comment) : null }));
  const { error } = await db().from("shop_reviews").upsert(rows);
  if (error) throw new Error(`shop_reviews: ${error.message}`);
  if (!before) return { new: fresh.length, low: 0 }; // lần đầu: nạp lịch sử, không báo dồn
  const low = rows.filter((r) => r.rating <= 3 && !r.replied);
  if (!low.length) return { new: fresh.length, low: 0 };
  const names = await itemNames(shop.shopId, low.map((r) => r.item_id));
  for (const r of low.slice(0, 10)) {
    const topic = (r.topic ?? "khac") as ReviewTopic;
    const reply = lowReply(topic);
    const id = await createTask(shop.shopId, "reply_low", { comment_id: r.comment_id, reply });
    const text =
      `⭐ <b>${esc(shop.name)}: đánh giá ${r.rating} sao</b>\n` +
      `Sản phẩm: ${esc((names.get(r.item_id) ?? String(r.item_id)).slice(0, 80))}\n` +
      `Đơn <code>${esc(r.order_sn ?? "-")}</code> · lý do: ${TOPIC_VI[topic]}\n` +
      `“${esc(r.comment || "(không viết gì)")}”\n\n` +
      `<b>Trả lời soạn sẵn:</b>\n${esc(reply)}\n\n` +
      `Muốn sửa câu trả lời: <code>/traloi ${r.comment_id} nội dung</code>`;
    const msgId = await sendTelegramMessage(text, { replyMarkup: taskButtons(id) });
    if (msgId) await db().from("shop_tasks").update({ message_id: msgId }).eq("id", id);
  }
  return { new: fresh.length, low: low.length };
}

/** 20h: gom đánh giá 4–5 sao chưa trả lời trong 3 ngày, đề xuất trả lời cảm ơn hàng loạt. */
async function proposeThanks(shop: ShopConf): Promise<number> {
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data } = await db()
    .from("shop_reviews")
    .select("comment_id, rating, comment")
    .eq("shop_id", shop.shopId)
    .eq("replied", false)
    .gte("rating", 4)
    .gte("create_time", since)
    .limit(100);
  const list = data ?? [];
  if (!list.length) return 0;
  const items = list.map((r: any) => ({ comment_id: String(r.comment_id), reply: thankReply(r.comment_id) }));
  const id = await createTask(shop.shopId, "reply_batch", { items });
  const withText = list.filter((r: any) => r.comment).length;
  const msgId = await sendTelegramMessage(
    `💬 <b>${esc(shop.name)}: ${list.length} đánh giá 4–5 sao chưa trả lời</b> (3 ngày qua, ${withText} có viết nhận xét)\n` +
      `Em trả lời cảm ơn tất cả, xoay vòng ${THANKS.length} mẫu, ví dụ:\n“${esc(THANKS[0])}”`,
    { replyMarkup: taskButtons(id) }
  );
  if (msgId) await db().from("shop_tasks").update({ message_id: msgId }).eq("id", id);
  return list.length;
}

/** Gửi trả lời lên Shopee (tối đa 100/lần). Trả về số trả lời thành công và lỗi đầu tiên. */
async function sendReplies(shopId: number, items: { comment_id: string; reply: string }[]): Promise<{ ok: number; failed: number; error: string | null }> {
  let ok = 0;
  let failed = 0;
  let error: string | null = null;
  for (const part of chunk(items, 100)) {
    const res = await callShopee(
      shopId,
      "product.reply_comment",
      { comment_list: part.map((i) => ({ comment_id: Number(i.comment_id), comment: i.reply.slice(0, 500) })) },
      { allowWrite: true }
    );
    const results: any[] = res.response?.result_list ?? [];
    const failedIds = new Set(results.filter((r) => r.fail_error).map((r) => String(r.comment_id)));
    for (const i of part) {
      if (failedIds.has(i.comment_id)) {
        failed++;
        error ??= String(results.find((r) => String(r.comment_id) === i.comment_id)?.fail_message ?? "lỗi");
      } else {
        ok++;
        await db().from("shop_reviews").update({ replied: true, reply: i.reply, replied_at: new Date().toISOString() }).eq("comment_id", i.comment_id);
      }
    }
  }
  return { ok, failed, error };
}

/** Bấm nút trên tin đánh giá. */
export async function decideTask(id: number, approve: boolean): Promise<string> {
  const { data: claimed } = await db()
    .from("shop_tasks")
    .update({ status: approve ? "approved" : "rejected", decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "proposed")
    .select("*");
  const t = claimed?.[0];
  if (!t) return "Việc này đã xử lý rồi";
  const note = async (s: string) => {
    if (t.message_id) await editTelegram(t.message_id, s);
  };
  if (!approve) {
    await note("✖️ Anh bỏ qua, em không trả lời.");
    return "Đã bỏ qua";
  }
  const items: { comment_id: string; reply: string }[] = t.kind === "reply_low" ? [t.payload] : t.payload?.items ?? [];
  try {
    const r = await sendReplies(t.shop_id, items);
    const status = r.failed && !r.ok ? "failed" : "executed";
    await db().from("shop_tasks").update({ status, error: r.error }).eq("id", id);
    await note(
      t.kind === "reply_low"
        ? r.ok
          ? `✅ Đã trả lời đánh giá:\n${esc(items[0].reply)}`
          : `⚠️ Không gửi được: ${esc(r.error ?? "")}`
        : `✅ Đã trả lời ${r.ok}/${items.length} đánh giá.${r.failed ? ` ${r.failed} lỗi: ${esc(r.error ?? "")}` : ""}`
    );
    return r.ok ? `Đã trả lời ${r.ok}` : "Lỗi, xem tin nhắn";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db().from("shop_tasks").update({ status: "failed", error: msg.slice(0, 500) }).eq("id", id);
    await note(`⚠️ Lỗi khi gửi lên Shopee: <code>${esc(msg.slice(0, 300))}</code>`);
    return "Lỗi, xem tin nhắn";
  }
}

/** Lệnh /traloi <comment_id> <nội dung>: anh tự viết câu trả lời. */
export async function replyCommand(arg: string): Promise<string> {
  const m = /^(\d+)\s+([\s\S]+)$/.exec(arg.trim());
  if (!m) return "Dùng: /traloi <mã đánh giá> <nội dung trả lời>";
  const { data: r } = await db().from("shop_reviews").select("shop_id, replied").eq("comment_id", m[1]).maybeSingle();
  if (!r) return "Không tìm thấy đánh giá này";
  if (r.replied) return "Đánh giá này đã được trả lời (Shopee chỉ cho trả lời 1 lần)";
  const res = await sendReplies(r.shop_id, [{ comment_id: m[1], reply: m[2].trim() }]);
  if (res.ok) {
    await db().from("shop_tasks").update({ status: "executed", decided_at: new Date().toISOString() }).eq("status", "proposed").eq("kind", "reply_low").contains("payload", { comment_id: m[1] });
    return "✅ Đã gửi câu trả lời của anh.";
  }
  return `⚠️ Không gửi được: ${esc(res.error ?? "")}`;
}

// ---------------------------------------------------------------------------
// Sức khỏe shop
// ---------------------------------------------------------------------------

export async function shopHealth(shopId: number) {
  const perf = await callShopee(shopId, "account_health.get_shop_performance", {});
  const metrics: Metric[] = perf.response?.metric_list ?? [];
  const pen = await callShopee(shopId, "account_health.get_penalty_point_history", { page_no: 1, page_size: 100 }).catch(() => null);
  const points = (pen?.response?.penalty_point_list ?? []).reduce((s: number, p: any) => s + Number(p.latest_point_num ?? p.original_point_num ?? 0), 0);
  const rating = metrics.find((m) => m.metric_name === "shop_rating")?.current_period ?? null;
  return { metrics, issues: healthIssues(metrics), penaltyPoints: points, rating };
}

/** Dòng cho báo cáo sáng + việc cần làm. */
export async function healthMorning(shopId: number): Promise<{ lines: string[]; todo: string[] }> {
  const h = await shopHealth(shopId);
  const lines = [`• Sức khỏe shop: ${h.rating != null ? `${h.rating} sao` : ""}${h.penaltyPoints ? ` · <b>⚠️ ${h.penaltyPoints} điểm phạt quý này</b>` : " · 0 điểm phạt"}`];
  const todo: string[] = [];
  for (const i of h.issues) {
    lines.push(`   – ${i.level === "vuot" ? "❌" : "⚠️"} ${esc(i.name)}: ${i.value} (mục tiêu ${esc(i.target)})`);
    if (i.level === "vuot") todo.push(`${i.name} không đạt (${i.value}, mục tiêu ${i.target})`);
  }
  const { count } = await db()
    .from("shop_tasks")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", shopId)
    .eq("status", "proposed")
    .eq("kind", "reply_low");
  if (count) todo.push(`Trả lời ${count} đánh giá xấu đang chờ`);
  return { lines, todo };
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/** Mỗi giờ 8h–22h: đơn trễ, đánh giá mới; 20h: đề xuất cảm ơn hàng loạt; 9h: cảnh báo sức khỏe. */
export async function careJob() {
  const hour = vnHour();
  const out: Record<string, unknown> = {};
  for (const shop of shops()) {
    const r: Record<string, unknown> = {};
    for (const [name, fn] of [
      ["late", () => scanLate(shop)],
      ["reviews", () => scanReviews(shop)],
      ["thanks", () => (hour === 20 ? proposeThanks(shop) : Promise.resolve(null))],
      [
        "health",
        async () => {
          if (hour !== 9) return null;
          const h = await shopHealth(shop.shopId);
          const bad = h.issues.filter((i) => i.level === "vuot");
          if (bad.length || h.penaltyPoints)
            await sendAlertOnce(
              `care:health:${shop.shopId}:${vnDate()}`,
              `🩺 <b>${esc(shop.name)}: sức khỏe shop cần chú ý</b>\n${bad.map((i) => `• ${esc(i.name)}: ${i.value} (mục tiêu ${esc(i.target)})`).join("\n")}${h.penaltyPoints ? `\n• Điểm phạt quý này: ${h.penaltyPoints}` : ""}`,
              24 * 60
            );
          return { issues: h.issues.length, points: h.penaltyPoints };
        },
      ],
    ] as [string, () => Promise<unknown>][]) {
      try {
        r[name] = await fn();
      } catch (err) {
        r[name] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    out[shop.name] = r;
  }
  return out;
}

/** Thứ Hai 8h15: báo cáo tuần chăm shop (đánh giá, sức khỏe, đơn trễ). */
export async function careWeeklyJob() {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const parts = ["📅 <b>Tuần qua: chăm shop Shopee</b>"];
  for (const shop of shops()) {
    try {
      const { data } = await db().from("shop_reviews").select("rating, topic, replied").eq("shop_id", shop.shopId).gte("create_time", since).limit(5000);
      const rows = data ?? [];
      const byStar = [5, 4, 3, 2, 1].map((s) => `${s}★ ${rows.filter((r: any) => r.rating === s).length}`).join(" · ");
      const low = rows.filter((r: any) => r.rating <= 3);
      const topics = new Map<string, number>();
      for (const r of low) topics.set(r.topic ?? "khac", (topics.get(r.topic ?? "khac") ?? 0) + 1);
      const replied = rows.filter((r: any) => r.replied).length;
      const h = await shopHealth(shop.shopId).catch(() => null);
      const late = await lateOrders(shop.shopId).catch(() => []);
      parts.push(
        `\n🏪 <b>${esc(shop.name)}</b>`,
        `• Đánh giá: ${rows.length} (${byStar}); đã trả lời ${replied}`,
        low.length
          ? `• Lý do chê: ${[...topics.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${TOPIC_VI[k as ReviewTopic] ?? k} ${v}`).join(", ")}`
          : "• Không có đánh giá ≤ 3 sao",
        h ? `• Sức khỏe: ${h.rating ?? "-"} sao, ${h.penaltyPoints} điểm phạt, ${h.issues.filter((i) => i.level === "vuot").length} chỉ số không đạt` : "• Sức khỏe: không đọc được",
        `• Đơn đang trễ hạn giao: ${late.length}`
      );
    } catch (err) {
      parts.push(`\n<b>${esc(shop.name)}</b>: lỗi — <code>${esc(String(err)).slice(0, 200)}</code>`);
    }
  }
  const sent = await sendTelegram(parts.join("\n"));
  return { sent };
}
