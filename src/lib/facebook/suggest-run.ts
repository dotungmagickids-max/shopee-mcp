/**
 * FB Magic Tool — Đề xuất chạy theo mã sản phẩm và theo bài (hàm thuần, không gọi mạng, dễ test).
 * Ngưỡng mặc định anh chốt 25/11/2026 (sổ tay Kiều Trang): xét 14 ngày gần nhất; scale khi ≥2 đơn, % dưới trần lãi của
 * mã, hàng còn ≥3 ngày bán; đừng chạy khi hàng còn <3 ngày hoặc chi >150k chưa có đơn; thử mã khi hàng còn >30 ngày bán
 * và 14 ngày chi <300k. Chỉ gợi ý, không có lệnh ghi lên Meta.
 */
import { ceilingFor, type Ceiling } from "./magic";

export const SUGGEST_RULES = {
  days: 14,
  scaleMinOrders: 2,
  minStockDays: 3,
  stopSpendNoOrder: 150_000,
  tryStockDays: 30,
  tryMaxSpend: 300_000,
  /** Mã lãi nhưng mới chạy ≤ ngần này bài và còn bài chưa chạy → "Test thêm bài" thay vì "Scale". */
  testMaxPostsRun: 2,
};
export type SuggestRules = typeof SUGGEST_RULES;

/** Một quảng cáo, cộng dồn trong khoảng xét. Chi đã nhân 1,111. */
export type AdStat = {
  ad_id: string;
  ad_name: string | null;
  story_id: string | null;
  /** Mã đọc từ tên quảng cáo / chiến dịch / đơn Pancake. */
  codes: string[];
  running: boolean;
  spendReal: number;
  orders: number;
  revenue: number;
};

export type SuggestPost = {
  id: string;
  page_id: string;
  day: string;
  picture: string | null;
  permalink: string | null;
  message: string;
  codes: string[];
  offWall: boolean;
  /** Loại bài (ảnh, video, reel…); màn Lịch content dùng để biết mã đang thiếu dạng nào. */
  kind?: "video" | "reel" | "photo" | "other";
};

export type PostVerdict = "winner" | "rerun" | "new" | "loser" | "watch";
export const VERDICT_LABEL: Record<PostVerdict, string> = {
  winner: "Bài thắng, đang chạy",
  rerun: "Từng tốt, đang tắt",
  new: "Chưa chạy",
  loser: "Lỗ / chưa ra đơn",
  watch: "Đang theo dõi",
};

export type PostStat = {
  story_id: string;
  page_id: string;
  /** null = bài cũ hơn khoảng đọc bài (chỉ biết qua quảng cáo). */
  post: SuggestPost | null;
  codes: string[];
  ads: number;
  running: number;
  adNames: string[];
  spendReal: number;
  orders: number;
  revenue: number;
  ratio: number | null;
  verdict: PostVerdict;
};

export type CodeLabel = "scale" | "test" | "try" | "watch" | "stop";
export const LABEL_TEXT: Record<CodeLabel, string> = {
  scale: "Scale",
  test: "Test thêm bài",
  try: "Thử mã",
  watch: "Theo dõi",
  stop: "Đừng chạy",
};
export const LABEL_ORDER: CodeLabel[] = ["scale", "test", "try", "watch", "stop"];

export type CodeRow = {
  code: string;
  label: CodeLabel;
  reason: string;
  spendReal: number;
  orders: number;
  revenue: number;
  ratio: number | null;
  ceiling: Ceiling;
  stock: number | null;
  stockDays: number | null;
  adsRunning: number;
  postsRun: number;
  postsNew: number;
  posts: PostStat[];
};

export type StockMap = Map<string, { stock: number; days: number | null }>;

const ratioOf = (spend: number, revenue: number) => (revenue > 0 ? spend / revenue : null);
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);
export const money = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")}tr` : `${Math.round(n / 1000)}k`);

export function postVerdict(s: { spendReal: number; orders: number; revenue: number; running: number }, c: Ceiling, rules: SuggestRules = SUGGEST_RULES): PostVerdict {
  if (s.spendReal <= 0) return "new";
  const r = ratioOf(s.spendReal, s.revenue);
  if (s.orders >= rules.scaleMinOrders && r != null && r < c.profit_ceiling) return s.running > 0 ? "winner" : "rerun";
  if ((s.orders === 0 && s.spendReal > rules.stopSpendNoOrder) || (r != null && r > c.breakeven)) return "loser";
  return "watch";
}

/** Nhãn của một mã cùng lý do bằng số. Thứ tự xét: hết hàng → chi không ra đơn → vượt hòa vốn → lãi → thử → theo dõi. */
export function codeLabel(
  a: { spendReal: number; orders: number; revenue: number; postsRun: number; postsNew: number },
  stock: { stock: number; days: number | null } | null,
  c: Ceiling,
  rules: SuggestRules = SUGGEST_RULES
): { label: CodeLabel; reason: string } {
  const r = ratioOf(a.spendReal, a.revenue);
  const head = `${rules.days} ngày qua: chi ${money(a.spendReal)}, ${a.orders} đơn, ${pct(r)}`;
  const daysTxt = stock?.days != null ? `còn ~${Math.max(0, Math.floor(stock.days))} ngày hàng` : stock ? `tồn ${stock.stock}, chưa có tốc độ bán` : "chưa có số tồn";
  if (stock && (stock.stock <= 0 || (stock.days != null && stock.days < rules.minStockDays))) {
    return { label: "stop", reason: `Sắp hết hàng (${stock.stock <= 0 ? "hết tồn" : daysTxt}). ${head}.` };
  }
  if (a.orders === 0 && a.spendReal > rules.stopSpendNoOrder) return { label: "stop", reason: `${head}: chi quá ${money(rules.stopSpendNoOrder)} chưa có đơn.` };
  if (r != null && r > c.breakeven) return { label: "stop", reason: `${head}: vượt hòa vốn ${pct(c.breakeven)}.` };
  if (a.orders >= rules.scaleMinOrders && r != null && r < c.profit_ceiling) {
    if (a.postsRun <= rules.testMaxPostsRun && a.postsNew > 0) {
      return { label: "test", reason: `${head}, dưới trần ${pct(c.profit_ceiling)}; mới chạy ${a.postsRun} bài, còn ${a.postsNew} bài chưa chạy; ${daysTxt}.` };
    }
    return { label: "scale", reason: `${head}, dưới trần ${pct(c.profit_ceiling)}; ${daysTxt}.` };
  }
  const slow = stock && stock.stock > 0 && (stock.days == null || stock.days > rules.tryStockDays);
  if (slow && a.spendReal < rules.tryMaxSpend) {
    return { label: "try", reason: `Hàng bán chậm (${daysTxt}, tồn ${stock!.stock}). ${a.spendReal > 0 ? head : `${rules.days} ngày qua chưa chạy`}.` };
  }
  return { label: "watch", reason: a.spendReal > 0 ? `${head}; ${daysTxt}.` : `Chưa chạy trong ${rules.days} ngày; ${daysTxt}.` };
}

/**
 * Gom quảng cáo theo bài gốc, gom bài theo mã, rồi xếp nhãn. Mã của quảng cáo: mã của bài gốc nếu đọc được bài, không
 * thì mã từ tên quảng cáo. Bài có 2 mã được tính cho cả hai mã. Bài ngoài tường chưa chạy không đưa vào (không lên camp được).
 */
export function buildSuggestions(
  input: { ads: AdStat[]; posts: SuggestPost[]; stock: StockMap; ceilings: Map<string, Ceiling> },
  rules: SuggestRules = SUGGEST_RULES
): CodeRow[] {
  const postById = new Map(input.posts.map((p) => [p.id, p]));
  const byStory = new Map<string, PostStat>();
  const loose: AdStat[] = []; // quảng cáo không rõ bài gốc
  for (const a of input.ads) {
    if (!a.story_id) {
      loose.push(a);
      continue;
    }
    const post = postById.get(a.story_id) ?? null;
    const s =
      byStory.get(a.story_id) ??
      ({ story_id: a.story_id, page_id: a.story_id.split("_")[0], post, codes: post?.codes.length ? post.codes : [], ads: 0, running: 0, adNames: [], spendReal: 0, orders: 0, revenue: 0, ratio: null, verdict: "new" } as PostStat);
    s.ads += 1;
    if (a.running) s.running += 1;
    s.spendReal += a.spendReal;
    s.orders += a.orders;
    s.revenue += a.revenue;
    if (!post?.codes.length) s.codes = [...new Set([...s.codes, ...a.codes])];
    if (a.ad_name && s.adNames.length < 5 && !s.adNames.includes(a.ad_name)) s.adNames.push(a.ad_name);
    byStory.set(a.story_id, s);
  }
  for (const p of input.posts) {
    if (byStory.has(p.id) || p.offWall || !p.codes.length) continue;
    byStory.set(p.id, { story_id: p.id, page_id: p.page_id, post: p, codes: p.codes, ads: 0, running: 0, adNames: [], spendReal: 0, orders: 0, revenue: 0, ratio: null, verdict: "new" });
  }
  for (const s of byStory.values()) {
    s.ratio = ratioOf(s.spendReal, s.revenue);
    s.verdict = postVerdict(s, ceilingFor(s.codes, input.ceilings), rules);
  }

  const codes = new Map<string, { posts: PostStat[]; loose: AdStat[] }>();
  const slot = (c: string) => codes.get(c) ?? (codes.set(c, { posts: [], loose: [] }), codes.get(c)!);
  for (const s of byStory.values()) for (const c of s.codes) slot(c).posts.push(s);
  for (const a of loose) for (const c of a.codes) slot(c).loose.push(a);

  const rows: CodeRow[] = [];
  for (const [code, g] of codes) {
    const sum = (k: "spendReal" | "orders" | "revenue") => g.posts.reduce((t, p) => t + p[k], 0) + g.loose.reduce((t, a) => t + a[k], 0);
    const spendReal = Math.round(sum("spendReal"));
    const orders = sum("orders");
    const revenue = Math.round(sum("revenue"));
    const postsRun = g.posts.filter((p) => p.spendReal > 0).length;
    const postsNew = g.posts.filter((p) => p.verdict === "new").length;
    const adsRunning = g.posts.reduce((t, p) => t + p.running, 0) + g.loose.filter((a) => a.running).length;
    const ceiling = ceilingFor([code], input.ceilings);
    const st = input.stock.get(code) ?? null;
    const { label, reason } = codeLabel({ spendReal, orders, revenue, postsRun, postsNew }, st, ceiling, rules);
    const rank: Record<PostVerdict, number> = { winner: 0, rerun: 1, new: 2, watch: 3, loser: 4 };
    const posts = [...g.posts].sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.revenue - a.revenue || (b.post?.day ?? "").localeCompare(a.post?.day ?? ""));
    rows.push({ code, label, reason, spendReal, orders, revenue, ratio: ratioOf(spendReal, revenue), ceiling, stock: st?.stock ?? null, stockDays: st?.days ?? null, adsRunning, postsRun, postsNew, posts });
  }
  const order = new Map(LABEL_ORDER.map((l, i) => [l, i]));
  return rows.sort((a, b) => order.get(a.label)! - order.get(b.label)! || b.revenue - a.revenue || (b.stock ?? 0) - (a.stock ?? 0) || a.code.localeCompare(b.code));
}

/** Nút lên camp cho một mã: gom bài theo page (màn Lên camp làm từng page). Scale = bài thắng + bài từng tốt; test = bài chưa chạy. */
export function launchGroups(row: CodeRow, max = 10): { kind: "scale" | "test"; page_id: string; posts: string[] }[] {
  const out: { kind: "scale" | "test"; page_id: string; posts: string[] }[] = [];
  const add = (kind: "scale" | "test", list: PostStat[]) => {
    const byPage = new Map<string, string[]>();
    for (const p of list) {
      if (p.post?.offWall) continue;
      const ids = byPage.get(p.page_id) ?? [];
      if (ids.length < max) ids.push(p.story_id);
      byPage.set(p.page_id, ids);
    }
    for (const [page_id, posts] of byPage) out.push({ kind, page_id, posts });
  };
  if (row.label === "stop") return out;
  add("scale", row.posts.filter((p) => p.verdict === "winner" || p.verdict === "rerun"));
  add("test", row.posts.filter((p) => p.verdict === "new"));
  return out;
}
