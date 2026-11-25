/**
 * Lịch content đa kênh và mục "Thiếu content gì" (hàm thuần, không gọi mạng, dễ test).
 * Lịch: mỗi dòng là một bài cần làm / đã xếp ngày đăng cho Facebook, Shopee, TikTok.
 * Thiếu gì: so bài đã đăng với nhãn đề xuất chạy của từng mã để biết mã nào thiếu ảnh, thiếu video, hết bài để test.
 */
import { parseCodes } from "./content";
import type { CodeLabel, CodeRow, StockMap, SuggestPost } from "./suggest-run";

export const CHANNELS = { facebook: "Facebook", shopee: "Shopee", tiktok: "TikTok", khac: "Khác" } as const;
export type Channel = keyof typeof CHANNELS;
export const FORMATS = { anh: "Ảnh", video: "Video", reel: "Reel", live: "Livestream", khac: "Khác" } as const;
export type Format = keyof typeof FORMATS;
export const STATUSES = { de_xuat: "Đề xuất", can_lam: "Cần làm", dang_lam: "Đang làm", xong: "Làm xong", da_dang: "Đã đăng", bo: "Bỏ" } as const;
export type Status = keyof typeof STATUSES;
/** Dòng còn phải làm (chưa đăng, chưa bỏ). */
export const isOpen = (s: Status) => s !== "da_dang" && s !== "bo";

export type PlanItem = {
  id: number;
  ngay: string | null;
  kenh: Channel;
  noi_dang: string;
  ma: string[];
  dang: Format;
  tieu_de: string;
  ghi_chu: string;
  ly_do: string;
  nguoi: string;
  trang_thai: Status;
  link: string;
  task_id: number | null;
  nguon: "tay" | "de_xuat";
  created_at: string;
};

/** Nơi đăng ngoài Facebook (page Facebook lấy từ danh sách page của FB Magic Tool). */
export const OTHER_PLACES: { kenh: Channel; noi: string }[] = [
  { kenh: "shopee", noi: "Shopee Magickids" },
  { kenh: "shopee", noi: "Shopee Annie Baby" },
  { kenh: "tiktok", noi: "TikTok Magickids" },
  { kenh: "khac", noi: "Khác" },
];

export const placeLabel = (kenh: Channel, noi: string, pages: Record<string, string>) => (kenh === "facebook" ? pages[noi] ?? (noi || "Facebook") : noi || CHANNELS[kenh]);

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const shiftDay = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Thứ Hai của tuần chứa `day`. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Chủ nhật
  return shiftDay(day, -((dow + 6) % 7));
}
export const DOW = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

export type PlanInput = Omit<PlanItem, "id" | "task_id" | "created_at">;

/**
 * Đọc form thêm/sửa một dòng lịch. `noi` có dạng "kenh|nơi đăng" (vd "facebook|1599…", "shopee|Shopee Magickids").
 * Sai thì trả câu báo lỗi bằng tiếng Việt.
 */
export function parsePlanForm(get: (k: string) => string, pages: Record<string, string>): { ok: true; row: PlanInput } | { ok: false; error: string } {
  const ngay = get("ngay");
  if (ngay && !isDay(ngay)) return { ok: false, error: "Ngày đăng không hợp lệ." };
  const [kenhRaw, ...rest] = get("noi").split("|");
  const noi = rest.join("|").trim().slice(0, 80);
  if (!(kenhRaw in CHANNELS)) return { ok: false, error: "Chọn kênh và nơi đăng." };
  const kenh = kenhRaw as Channel;
  if (kenh === "facebook" && !pages[noi]) return { ok: false, error: "Chọn page Facebook trong danh sách." };
  const dang = get("dang") || "anh";
  if (!(dang in FORMATS)) return { ok: false, error: "Chọn dạng bài." };
  const trang_thai = get("trang_thai") || "can_lam";
  if (!(trang_thai in STATUSES)) return { ok: false, error: "Trạng thái không hợp lệ." };
  const ma = parseCodes(get("ma"));
  if (get("ma").trim() && !ma.length) return { ok: false, error: "Mã sản phẩm không đọc được. Ví dụ: BD26011, ADT25003." };
  const tieu_de = get("tieu_de").slice(0, 200);
  if (!ma.length && !tieu_de) return { ok: false, error: "Nhập mã sản phẩm hoặc ý tưởng bài." };
  const link = get("link").slice(0, 500);
  if (link && !/^https?:\/\//i.test(link)) return { ok: false, error: "Link bài phải bắt đầu bằng http." };
  return {
    ok: true,
    row: {
      ngay: ngay || null,
      kenh,
      noi_dang: noi,
      ma,
      dang: dang as Format,
      tieu_de,
      ghi_chu: get("ghi_chu").slice(0, 1000),
      ly_do: get("ly_do").slice(0, 500),
      nguoi: get("nguoi").slice(0, 50),
      trang_thai: trang_thai as Status,
      link,
      nguon: get("nguon") === "de_xuat" ? "de_xuat" : "tay",
    },
  };
}

const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");

/** Tiêu đề và chi tiết của việc giao trên bảng việc chung: một việc rõ ràng, có page/shop, mã, dạng bài, cần gửi lại gì. */
export function taskOf(item: PlanItem, pages: Record<string, string>): { title: string; detail: string } {
  const place = item.kenh === "facebook" ? `page ${placeLabel(item.kenh, item.noi_dang, pages)}` : placeLabel(item.kenh, item.noi_dang, pages);
  const what = `${FORMATS[item.dang].toLowerCase()}${item.ma.length ? ` mã ${item.ma.join(", ")}` : ""}`;
  const title = `Làm content ${what} cho ${place}${item.ngay ? `, đăng ${dm(item.ngay)}` : ""}. Gửi lại link bài hoặc thư mục ảnh/video.`;
  const detail = [item.tieu_de && `Ý tưởng: ${item.tieu_de}`, item.ly_do && `Lý do: ${item.ly_do}`, item.ghi_chu && `Ghi chú: ${item.ghi_chu}`, `Dòng lịch content số ${item.id}.`].filter(Boolean).join("\n");
  return { title: title.slice(0, 300), detail };
}

const kindOk = (dang: Format, kind: SuggestPost["kind"]) => (dang === "anh" ? kind === "photo" : dang === "video" || dang === "reel" ? kind === "video" || kind === "reel" : true);

/**
 * Bài Facebook đã đăng khớp với một dòng lịch: cùng page, có chung mã, đúng dạng, đăng từ ngày tạo dòng trở đi.
 * Chỉ để hiện "đã thấy bài" trên lịch; không tự đổi trạng thái.
 */
export function matchPosted(item: PlanItem, posts: SuggestPost[]): SuggestPost | null {
  if (item.kenh !== "facebook" || !item.ma.length || !isOpen(item.trang_thai)) return null;
  const from = item.created_at.slice(0, 10);
  const hits = posts.filter((p) => p.page_id === item.noi_dang && p.day >= from && p.codes.some((c) => item.ma.includes(c)) && kindOk(item.dang, p.kind));
  return hits.sort((a, b) => a.day.localeCompare(b.day))[0] ?? null;
}

// ---------- Thiếu content gì ----------

export const GAP_RULES = {
  /** Xét bài trong ngần này ngày gần nhất để biết mã thiếu ảnh hay thiếu video. */
  kindDays: 30,
  /** Mã chưa có bài: chỉ báo khi tồn từ ngần này trở lên, lấy tối đa `noPostMax` mã tồn nhiều nhất. */
  noPostMinStock: 50,
  noPostMax: 30,
};

export type GapFlag = "thieu_anh" | "thieu_video" | "het_bai_test" | "mot_page" | "chua_co_bai";
export const GAP_TEXT: Record<GapFlag, string> = {
  thieu_anh: "Thiếu bài ảnh",
  thieu_video: "Thiếu video / reel",
  het_bai_test: "Hết bài để test",
  mot_page: "Chỉ có bài trên 1 page",
  chua_co_bai: "Chưa có bài nào",
};
export const GAP_ORDER: GapFlag[] = ["het_bai_test", "thieu_anh", "thieu_video", "mot_page", "chua_co_bai"];

export type Gap = {
  code: string;
  flag: GapFlag;
  label: CodeLabel | null;
  reason: string;
  /** Gợi ý dòng lịch: dạng bài và page nên đăng. */
  dang: Format;
  page_id: string | null;
  stock: number | null;
  /** Dòng lịch còn mở đã có cho đúng mã và dạng này. */
  plannedId: number | null;
};

const SHOULD_RUN: CodeLabel[] = ["scale", "test", "try"];

/**
 * `rows` = kết quả đề xuất chạy theo mã; `posts` = mọi bài đọc được (60 ngày, kể cả bài ngoài tường);
 * `multiPages` = các page cùng một thương hiệu (mã chỉ có bài trên 1 trong các page này thì báo "chỉ có bài trên 1 page").
 */
export function contentGaps(input: { rows: CodeRow[]; posts: SuggestPost[]; stock: StockMap; today: string; multiPages: string[]; planned: PlanItem[] }, rules = GAP_RULES): Gap[] {
  const { rows, posts, stock, today, multiPages, planned } = input;
  const byCode = new Map<string, SuggestPost[]>();
  for (const p of posts) for (const c of p.codes) byCode.set(c, [...(byCode.get(c) ?? []), p]);
  const since = shiftDay(today, -(rules.kindDays - 1));
  const openPlans = planned.filter((p) => isOpen(p.trang_thai));
  const plannedFor = (code: string, dang?: Format) =>
    openPlans.find((p) => p.ma.includes(code) && (!dang || (dang === "anh" ? p.dang === "anh" : p.dang === "video" || p.dang === "reel")))?.id ?? null;
  const out: Gap[] = [];

  for (const r of rows) {
    if (!SHOULD_RUN.includes(r.label)) continue;
    const all = byCode.get(r.code) ?? [];
    const recent = all.filter((p) => p.day >= since);
    const photos = recent.filter((p) => p.kind === "photo").length;
    const videos = recent.filter((p) => p.kind === "video" || p.kind === "reel").length;
    const perPage = new Map<string, number>();
    for (const p of all) perPage.set(p.page_id, (perPage.get(p.page_id) ?? 0) + 1);
    const topPage = [...perPage.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const base = { code: r.code, label: r.label, stock: r.stock };
    const have = `${rules.kindDays} ngày qua có ${photos} bài ảnh, ${videos} video/reel`;
    if (r.label === "scale" && r.postsNew === 0) {
      out.push({ ...base, flag: "het_bai_test", reason: `Mã đang lãi (${r.orders} đơn) nhưng không còn bài chưa chạy; ${have}.`, dang: videos <= photos ? "video" : "anh", page_id: topPage, plannedId: plannedFor(r.code) });
    }
    if (photos === 0) out.push({ ...base, flag: "thieu_anh", reason: `${have}.`, dang: "anh", page_id: topPage, plannedId: plannedFor(r.code, "anh") });
    if (videos === 0) out.push({ ...base, flag: "thieu_video", reason: `${have}.`, dang: "video", page_id: topPage, plannedId: plannedFor(r.code, "video") });
    if (perPage.size === 1 && topPage && multiPages.includes(topPage)) {
      const other = multiPages.find((p) => p !== topPage) ?? null;
      out.push({ ...base, flag: "mot_page", reason: `${all.length} bài của mã đều nằm trên một page.`, dang: photos >= videos ? "anh" : "video", page_id: other, plannedId: openPlans.find((p) => p.ma.includes(r.code) && p.noi_dang === other)?.id ?? null });
    }
  }

  const known = new Set(rows.map((r) => r.code));
  const noPost = [...stock.entries()]
    .filter(([code, s]) => /^[A-Z]{2,4}\d{5}$/.test(code) && s.stock >= rules.noPostMinStock && !byCode.has(code) && !known.has(code))
    .sort((a, b) => b[1].stock - a[1].stock)
    .slice(0, rules.noPostMax);
  for (const [code, s] of noPost) {
    out.push({ code, flag: "chua_co_bai", label: null, stock: s.stock, reason: `Tồn ${s.stock}${s.days != null ? `, ~${Math.floor(s.days)} ngày bán` : ", chưa có tốc độ bán"}; không thấy bài nào có mã này.`, dang: "anh", page_id: null, plannedId: plannedFor(code) });
  }
  const order = new Map(GAP_ORDER.map((f, i) => [f, i]));
  return out.sort((a, b) => order.get(a.flag)! - order.get(b.flag)! || (b.stock ?? 0) - (a.stock ?? 0) || a.code.localeCompare(b.code));
}
