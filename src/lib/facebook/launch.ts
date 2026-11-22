/**
 * FB Magic Tool — Phần 1: lên camp số lượng lớn (hàm thuần: lập kế hoạch, đặt tên, tham số gửi Meta).
 * Mọi thứ tạo ra luôn ở trạng thái TẠM DỪNG. Đặc tả: D:\Magic OS\docs\FB-MAGIC-TOOL-DAC-TA.md.
 */

export type Structure = "abo" | "cbo";
export type Gender = "all" | "female" | "male";

export type LaunchConfig = {
  page_id: string;
  /** Tài khoản quảng cáo; nhiều tài khoản thì chia đều lần lượt. */
  accounts: string[];
  /** ABO: ngân sách/ngày mỗi nhóm. CBO: ngân sách/ngày cả chiến dịch. */
  budget: number;
  structure: Structure;
  age_min: number;
  age_max: number;
  gender: Gender;
  /** auto = vị trí tự động; facebook = chỉ Facebook. */
  placement: "auto" | "facebook";
  /** Tên chiến dịch CBO (ABO thì mỗi bài một chiến dịch, tên theo quảng cáo). */
  cbo_name?: string;
};

export type LaunchItem = { post_id: string; name: string };

export const MIN_BUDGET = 50_000;
export const MAX_BUDGET = 5_000_000;
export const MAX_ITEMS = 30;

/** Mã sản phẩm trong nội dung bài: 2–3 chữ + 5 số (BD26011, ADT25002). */
export function codesFromText(text: string | null | undefined): string[] {
  return [...new Set(String(text ?? "").toUpperCase().match(/\b[A-Z]{2,3}\d{5}\b/g) ?? [])];
}

/**
 * Tên quảng cáo theo quy ước `MÃ-Pxx-Vxx`: Pxx là số thứ tự bài của mã đó (tiếp theo số lớn nhất đã dùng),
 * Vxx mặc định V01. Nhiều mã nối bằng dấu chấm. `used` = các tên đã có (quảng cáo cũ + tên vừa đặt trong lô).
 */
export function nextName(codes: string[], used: Iterable<string>): string {
  const head = codes.length ? codes.join(".") : "BAI";
  let max = 0;
  const re = new RegExp(`^${head.replace(/\./g, "\\.")}-P(\\d+)`, "i");
  for (const n of used) {
    const m = re.exec(String(n ?? "").trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${head}-P${String(max + 1).padStart(2, "0")}-V01`;
}

export function validate(cfg: LaunchConfig, items: LaunchItem[]): string | null {
  if (!/^\d{5,20}$/.test(cfg.page_id)) return "Page không hợp lệ.";
  if (!cfg.accounts.length || cfg.accounts.some((a) => !/^\d{5,20}$/.test(a))) return "Chọn ít nhất một tài khoản quảng cáo.";
  if (!items.length) return "Chưa chọn bài nào.";
  if (items.length > MAX_ITEMS) return `Mỗi lần tạo tối đa ${MAX_ITEMS} bài.`;
  if (!Number.isFinite(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET) {
    return `Ngân sách/ngày phải từ ${MIN_BUDGET.toLocaleString("vi-VN")} đến ${MAX_BUDGET.toLocaleString("vi-VN")}đ.`;
  }
  if (!(cfg.age_min >= 18 && cfg.age_min <= cfg.age_max && cfg.age_max <= 65)) return "Tuổi phải trong khoảng 18–65.";
  for (const it of items) {
    if (!/^\d+_\d+$/.test(it.post_id)) return `Mã bài không hợp lệ: ${it.post_id}`;
    if (!it.name.trim() || it.name.length > 200) return "Tên quảng cáo trống hoặc quá dài.";
    if (!it.post_id.startsWith(`${cfg.page_id}_`)) return `Bài ${it.post_id} không thuộc page đã chọn.`;
  }
  if (new Set(items.map((i) => i.post_id)).size !== items.length) return "Có bài bị chọn trùng.";
  return null;
}

/** Một chiến dịch sẽ tạo, kèm các nhóm (mỗi nhóm một bài, một quảng cáo). */
export type PlannedCampaign = {
  account_id: string;
  name: string;
  /** Ngân sách chiến dịch (CBO); null nếu ngân sách nằm ở nhóm. */
  daily_budget: number | null;
  adsets: { name: string; daily_budget: number | null; post_id: string; ad_name: string }[];
};

/**
 * ABO: mỗi bài một chiến dịch – một nhóm – một quảng cáo, ngân sách ở nhóm.
 * CBO: mỗi tài khoản một chiến dịch gộp, mỗi bài một nhóm, ngân sách ở chiến dịch.
 * Nhiều tài khoản: chia bài lần lượt (bài 1 → TK 1, bài 2 → TK 2, …).
 */
export function buildPlan(cfg: LaunchConfig, items: LaunchItem[]): PlannedCampaign[] {
  const out: PlannedCampaign[] = [];
  const cbo = new Map<string, PlannedCampaign>();
  items.forEach((it, i) => {
    const account_id = cfg.accounts[i % cfg.accounts.length];
    const name = it.name.trim();
    if (cfg.structure === "abo") {
      out.push({ account_id, name, daily_budget: null, adsets: [{ name, daily_budget: cfg.budget, post_id: it.post_id, ad_name: name }] });
      return;
    }
    let c = cbo.get(account_id);
    if (!c) {
      c = { account_id, name: (cfg.cbo_name ?? "").trim() || `CBO-${name}`, daily_budget: cfg.budget, adsets: [] };
      cbo.set(account_id, c);
      out.push(c);
    }
    c.adsets.push({ name, daily_budget: null, post_id: it.post_id, ad_name: name });
  });
  return out;
}

/** Tổng ngân sách/ngày của cả kế hoạch (số Meta). */
export function planBudget(plan: PlannedCampaign[]): number {
  return plan.reduce((s, c) => s + (c.daily_budget ?? c.adsets.reduce((x, a) => x + (a.daily_budget ?? 0), 0)), 0);
}

const PAUSED = "PAUSED";

/** Tham số tạo chiến dịch tin nhắn (CTX), luôn tạm dừng. */
export function campaignParams(c: PlannedCampaign): Record<string, string> {
  const p: Record<string, string> = {
    name: c.name,
    objective: "OUTCOME_ENGAGEMENT",
    status: PAUSED,
    special_ad_categories: "[]",
    buying_type: "AUCTION",
  };
  if (c.daily_budget) {
    p.daily_budget = String(Math.round(c.daily_budget));
    p.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
  } else p.is_adset_budget_sharing_enabled = "false";
  return p;
}

export function targeting(cfg: LaunchConfig): Record<string, unknown> {
  const t: Record<string, unknown> = {
    geo_locations: { countries: ["VN"] },
    age_min: cfg.age_min,
    age_max: cfg.age_max,
    // Tắt mở rộng đối tượng để Meta giữ đúng tuổi đã đặt.
    targeting_automation: { advantage_audience: 0 },
  };
  if (cfg.gender === "female") t.genders = [2];
  if (cfg.gender === "male") t.genders = [1];
  if (cfg.placement === "facebook") t.publisher_platforms = ["facebook"];
  return t;
}

/** Tham số tạo nhóm quảng cáo tin nhắn Messenger, luôn tạm dừng. */
export function adsetParams(cfg: LaunchConfig, campaignId: string, a: PlannedCampaign["adsets"][number]): Record<string, string> {
  const p: Record<string, string> = {
    name: a.name,
    campaign_id: campaignId,
    status: PAUSED,
    billing_event: "IMPRESSIONS",
    optimization_goal: "CONVERSATIONS",
    destination_type: "MESSENGER",
    promoted_object: JSON.stringify({ page_id: cfg.page_id }),
    targeting: JSON.stringify(targeting(cfg)),
  };
  if (a.daily_budget) {
    p.daily_budget = String(Math.round(a.daily_budget));
    p.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
  }
  return p;
}

export const creativeParams = (postId: string, name: string): Record<string, string> => ({ name, object_story_id: postId });

/**
 * Bài chưa có nút "Gửi tin nhắn" thì Meta từ chối gắn vào chiến dịch tin nhắn
 * ("creative is incompatible with the objective"). Bản này gắn thêm nút nhắn tin Messenger vào creative.
 */
export const creativeParamsWithCta = (postId: string, name: string): Record<string, string> => ({
  ...creativeParams(postId, name),
  call_to_action: JSON.stringify({ type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }),
});

/** Lỗi Meta báo bài không hợp mục tiêu tin nhắn (thường do bài thiếu nút nhắn tin). */
export const isCreativeIncompatible = (message: string): boolean => /creative is incompatible with the objective/i.test(message);

export const adParams = (name: string, adsetId: string, creativeId: string): Record<string, string> => ({
  name,
  adset_id: adsetId,
  creative: JSON.stringify({ creative_id: creativeId }),
  status: PAUSED,
});
