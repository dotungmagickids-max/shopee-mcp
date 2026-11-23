/**
 * FB Magic Tool — Phần 1: lên camp số lượng lớn (hàm thuần: lập kế hoạch, đặt tên, tham số gửi Meta).
 * Mọi thứ tạo ra luôn ở trạng thái TẠM DỪNG. Đặc tả: D:\Magic OS\docs\FB-MAGIC-TOOL-DAC-TA.md.
 */

export type Structure = "abo" | "cbo";
/**
 * Hình dạng camp (chiến dịch – nhóm – quảng cáo):
 * - "n-1-1": mỗi bài một chiến dịch riêng, một nhóm, một quảng cáo;
 * - "1-n-1": một chiến dịch, mỗi bài một nhóm (thường để scale);
 * - "1-1-n": một chiến dịch, một nhóm, mỗi bài một quảng cáo (thường để test).
 */
export type Shape = "n-1-1" | "1-n-1" | "1-1-n";
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
  /** Tên chiến dịch khi gộp nhiều bài vào một chiến dịch ("n-1-1" thì tên chiến dịch theo quảng cáo). */
  cbo_name?: string;
  /** Không ghi thì: CBO → "1-n-1", ABO → "n-1-1" (cách cũ). */
  shape?: Shape;
  /** Tên nhóm quảng cáo; "1-n-1" thì thêm số thứ tự -01, -02… Không ghi thì lấy tên quảng cáo. */
  adset_name?: string;
  /**
   * Hẹn giờ bắt đầu chạy, giờ Việt Nam, dạng "YYYY-MM-DDTHH:mm". Nhóm vẫn tạo ở trạng thái tạm dừng; sau khi anh bật,
   * Meta chờ tới giờ này mới phân phối. Không ghi = chạy ngay khi bật.
   */
  start_time?: string;
};

/** Giờ hẹn (giờ Việt Nam) → giây unix; sai dạng thì null. */
export function startUnix(v: string | undefined): number | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}:00+07:00`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}
export const MAX_START_DAYS = 60;

export const shapeOf = (cfg: Pick<LaunchConfig, "shape" | "structure">): Shape => cfg.shape ?? (cfg.structure === "cbo" ? "1-n-1" : "n-1-1");

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

export function validate(cfg: LaunchConfig, items: LaunchItem[], now: number = Date.now()): string | null {
  if (cfg.start_time) {
    const t = startUnix(cfg.start_time);
    if (t == null) return "Giờ hẹn bắt đầu chạy không hợp lệ.";
    if (t * 1000 < now + 10 * 60_000) return "Giờ hẹn bắt đầu chạy phải sau hiện tại ít nhất 10 phút.";
    if (t * 1000 > now + MAX_START_DAYS * 86_400_000) return `Giờ hẹn bắt đầu chạy không quá ${MAX_START_DAYS} ngày tới.`;
  }
  if (!/^\d{5,20}$/.test(cfg.page_id)) return "Page không hợp lệ.";
  if (!cfg.accounts.length || cfg.accounts.some((a) => !/^\d{5,20}$/.test(a))) return "Chọn ít nhất một tài khoản quảng cáo.";
  if (!items.length) return "Chưa chọn bài nào.";
  if (items.length > MAX_ITEMS) return `Mỗi lần tạo tối đa ${MAX_ITEMS} bài.`;
  if (!Number.isFinite(cfg.budget) || cfg.budget < MIN_BUDGET || cfg.budget > MAX_BUDGET) {
    return `Ngân sách/ngày phải từ ${MIN_BUDGET.toLocaleString("vi-VN")} đến ${MAX_BUDGET.toLocaleString("vi-VN")}đ.`;
  }
  if ((cfg.cbo_name ?? "").length > 200 || (cfg.adset_name ?? "").length > 180) return "Tên chiến dịch hoặc tên nhóm quá dài.";
  if (!(cfg.age_min >= 18 && cfg.age_min <= cfg.age_max && cfg.age_max <= 65)) return "Tuổi phải trong khoảng 18–65.";
  for (const it of items) {
    if (!/^\d+_\d+$/.test(it.post_id)) return `Mã bài không hợp lệ: ${it.post_id}`;
    if (!it.name.trim() || it.name.length > 200) return "Tên quảng cáo trống hoặc quá dài.";
    if (!it.post_id.startsWith(`${cfg.page_id}_`)) return `Bài ${it.post_id} không thuộc page đã chọn.`;
  }
  if (new Set(items.map((i) => i.post_id)).size !== items.length) return "Có bài bị chọn trùng.";
  return null;
}

export type PlannedAd = { post_id: string; ad_name: string };
/** Một chiến dịch sẽ tạo, kèm các nhóm; mỗi nhóm có một hoặc nhiều quảng cáo (mỗi quảng cáo một bài). */
export type PlannedCampaign = {
  account_id: string;
  name: string;
  /** Ngân sách chiến dịch (CBO); null nếu ngân sách nằm ở nhóm. */
  daily_budget: number | null;
  adsets: { name: string; daily_budget: number | null; ads: PlannedAd[] }[];
};

/**
 * Dựng kế hoạch theo hình dạng camp (`shapeOf`). ABO: ngân sách ở từng nhóm; CBO: ngân sách ở chiến dịch.
 * "1-n-1" và "1-1-n" gộp các bài vào một chiến dịch cho mỗi tài khoản.
 * Nhiều tài khoản: chia bài lần lượt (bài 1 → TK 1, bài 2 → TK 2, …).
 */
export function buildPlan(cfg: LaunchConfig, items: LaunchItem[]): PlannedCampaign[] {
  const out: PlannedCampaign[] = [];
  const shape = shapeOf(cfg);
  const cbo = cfg.structure === "cbo";
  const groupName = (cfg.adset_name ?? "").trim();
  const one = new Map<string, PlannedCampaign>();
  items.forEach((it, i) => {
    const account_id = cfg.accounts[i % cfg.accounts.length];
    const name = it.name.trim();
    const ad: PlannedAd = { post_id: it.post_id, ad_name: name };
    if (shape === "n-1-1") {
      // Mỗi bài một chiến dịch: ngân sách luôn ở nhóm.
      out.push({ account_id, name, daily_budget: null, adsets: [{ name: groupName || name, daily_budget: cfg.budget, ads: [ad] }] });
      return;
    }
    let c = one.get(account_id);
    if (!c) {
      c = { account_id, name: (cfg.cbo_name ?? "").trim() || `${cbo ? "CBO-" : ""}${name}`, daily_budget: cbo ? cfg.budget : null, adsets: [] };
      one.set(account_id, c);
      out.push(c);
    }
    if (shape === "1-n-1") {
      const stt = String(c.adsets.length + 1).padStart(2, "0");
      c.adsets.push({ name: groupName ? `${groupName}-${stt}` : name, daily_budget: cbo ? null : cfg.budget, ads: [ad] });
    } else if (c.adsets.length) c.adsets[0].ads.push(ad);
    else c.adsets.push({ name: groupName || name, daily_budget: cbo ? null : cfg.budget, ads: [ad] });
  });
  return out;
}

/** Mã page dùng trong tên chiến dịch (sổ tay Kiều Trang mục 4: `[Mục tiêu]-[Page]-[Mã SP/GOM]-[STT]`). */
export const pageShort = (pageName: string): string => {
  const n = pageName.toLowerCase().replace(/\s+/g, "");
  if (n.includes("official")) return "MGO";
  if (n.includes("store")) return "MGS";
  if (n.includes("annie")) return "AB";
  return "MG";
};

/**
 * Gợi ý tên chiến dịch `TT-<page>-<mã>-<STT>`: nhiều mã nối bằng dấu chấm, quá 2 mã hoặc không có mã thì ghi GOM;
 * STT = số lớn nhất đã dùng với cùng phần đầu + 1 (2 chữ số). `used` = tên các chiến dịch đã có.
 */
export function suggestCampaignName(page: string, codes: string[], used: Iterable<string>): string {
  const uniq = [...new Set(codes)];
  const head = `TT-${page}-${uniq.length && uniq.length <= 2 ? uniq.join(".") : "GOM"}`;
  const re = new RegExp(`^${head.replace(/\./g, "\\.")}-(\\d+)$`, "i");
  let max = 0;
  for (const n of used) {
    const m = re.exec(String(n ?? "").trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${head}-${String(max + 1).padStart(2, "0")}`;
}

/** Gợi ý tên nhóm `TN-<tệp>-<kiểu nhắm>`: TN = tối đa tin nhắn; tệp NU/NAM/ALL + tuổi; AUTO = vị trí tự động, FB = chỉ Facebook. */
export function suggestAdsetName(cfg: Pick<LaunchConfig, "gender" | "age_min" | "age_max" | "placement">): string {
  const who = cfg.gender === "female" ? "NU" : cfg.gender === "male" ? "NAM" : "ALL";
  return `TN-${who}${cfg.age_min}${cfg.age_max}-${cfg.placement === "facebook" ? "FB" : "AUTO"}`;
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
  const start = startUnix(cfg.start_time);
  if (start) p.start_time = String(start);
  return p;
}

/**
 * Tắt "thêm sản phẩm từ danh mục" (Nguồn quảng cáo: Sản phẩm). Từ Graph v27 Meta có thể tự bật mục này cho creative
 * không ghi gì, và không sửa được trên creative đã tạo, nên phải ghi ngay lúc tạo. Anh dặn 23/11: không chọn danh mục.
 */
export const NO_CATALOG = JSON.stringify({ creative_features_spec: { product_extensions: { enroll_status: "OPT_OUT", action_metadata: { type: "MANUAL" } } } });

/** Creative dùng bài có sẵn của page. `noCatalog` = kèm lệnh tắt danh mục sản phẩm (mặc định có). */
export const creativeParams = (postId: string, name: string, noCatalog = true): Record<string, string> => ({
  name,
  object_story_id: postId,
  ...(noCatalog ? { degrees_of_freedom_spec: NO_CATALOG } : {}),
});

/**
 * Bài chưa có nút "Gửi tin nhắn" thì Meta từ chối gắn vào chiến dịch tin nhắn
 * ("creative is incompatible with the objective"). Bản này gắn thêm nút nhắn tin Messenger vào creative.
 */
export const creativeParamsWithCta = (postId: string, name: string, noCatalog = true): Record<string, string> => ({
  ...creativeParams(postId, name, noCatalog),
  call_to_action: JSON.stringify({ type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } }),
});

/**
 * Thêm lời giải thích tiếng Việt cho lỗi Meta hay gặp. Lỗi quyền page: tài khoản hệ thống của web chưa được giao
 * quyền tạo quảng cáo cho page đó trong Cài đặt doanh nghiệp.
 */
export function explainMetaError(message: string): string {
  if (/need access to create ads for this Page/i.test(message)) {
    return `${message} → Web chưa có quyền tạo quảng cáo cho page này: vào Cài đặt doanh nghiệp Meta, giao page cho người dùng hệ thống của web với quyền tạo quảng cáo, rồi tạo lại.`;
  }
  return message;
}

/** Lỗi Meta báo bài không hợp mục tiêu tin nhắn (thường do bài thiếu nút nhắn tin). */
export const isCreativeIncompatible = (message: string): boolean => /creative is incompatible with the objective/i.test(message);

export const adParams = (name: string, adsetId: string, creativeId: string): Record<string, string> => ({
  name,
  adset_id: adsetId,
  creative: JSON.stringify({ creative_id: creativeId }),
  status: PAUSED,
});
