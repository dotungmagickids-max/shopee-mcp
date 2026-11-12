import type { RuleParams } from "./settings";

/** Nhóm hàng: mỗi nhóm một mục tiêu quảng cáo (và sau này: giá, voucher, flash sale…). */
export type ProductClass = "chu_luc" | "thuong" | "xa_kho" | "moi";
export const CLASSES: ProductClass[] = ["chu_luc", "thuong", "xa_kho", "moi"];

export const CLASS_VI: Record<ProductClass, string> = {
  chu_luc: "Chủ lực",
  thuong: "Thường",
  xa_kho: "Xả kho",
  moi: "Mới",
};

/**
 * Nhóm theo ma trận BCG (cách anh Tùng nghĩ về danh mục, 12/11/2026):
 *   Mới = Dấu hỏi: lãi ít / hòa vốn để lấy hiển thị và lượt mua.
 *   Chủ lực = Ngôi sao: vừa lãi vừa bán nhiều → tăng mạnh để tối đa tốc độ đi hàng và tổng lãi.
 *   Thường = Bò sữa: chạy đều → ưu tiên lãi cao, giữ nhịp, tăng vừa phải.
 *   Xả kho = Chó: lãi thấp / không lãi, thu tiền mặt.
 */
export const CLASS_BCG: Record<ProductClass, string> = {
  moi: "Dấu hỏi",
  chu_luc: "Ngôi sao",
  thuong: "Bò sữa",
  xa_kho: "Chó",
};

/**
 * Cơ cấu chi quảng cáo mục tiêu (anh chốt 12/11/2026): Chủ lực 40%, Thường 30% là mục tiêu ưu tiên (không phải trần);
 * Mới, Xả kho dùng trần cứng (new/clear_max_spend_share_pct).
 */
export function mixTargets(p: RuleParams): Record<ProductClass, number> {
  return { chu_luc: p.mix_core_pct, thuong: p.mix_regular_pct, moi: p.new_max_spend_share_pct, xa_kho: p.clear_max_spend_share_pct };
}

/** Nhóm Chủ lực / Thường đang thấp hơn mục tiêu cơ cấu ≥ 5 điểm: được tăng nhanh như Chủ lực. Trả ghi chú hoặc null. */
export function mixBoost(cls: ProductClass | undefined, share: Partial<Record<ProductClass, number>>, p: RuleParams): string | null {
  const c = (cls ?? "thuong") as ProductClass;
  if (c !== "chu_luc" && c !== "thuong") return null;
  const target = mixTargets(p)[c];
  const now = (share[c] ?? 0) * 100;
  if (!(target > 0) || now >= target - 5) return null;
  return `ưu tiên cơ cấu: ${CLASS_VI[c]} đang ${Math.round(now)}%/${target}% chi`;
}

/** Cách tăng ngân sách theo nhóm: tăng khi đã tiêu ≥ ratio ngân sách, mỗi lần +step%. */
export function scaleStyle(cls: ProductClass | undefined, p: RuleParams): { ratio: number; stepPct: number } {
  if (cls === "chu_luc") return { ratio: p.scale_core_spend_ratio, stepPct: p.scale_core_step_pct };
  return { ratio: p.scale_spend_ratio, stepPct: p.scale_step_pct };
}

export interface ClassInput {
  units30: number; // bán trên Shopee 30 ngày (đơn không hủy)
  stock: number | null; // tồn Pancake (null = không biết mã sản phẩm)
  dailySales: number; // bán/ngày (Pancake mọi kênh, hoặc Shopee 30 ngày)
  categories: Set<string>;
  ageDays: number | null; // tuổi sản phẩm trên Pancake
  costRatio: number | null;
  month: number; // tháng hiện tại (giờ VN), 1–12
}

/** Hàng trái mùa: danh mục Xuân hè vào tháng 10–2, Thu đông vào tháng 4–8. */
export function outOfSeason(categories: Set<string>, month: number): boolean {
  const names = [...categories].map((c) => c.toLowerCase());
  const summer = names.some((c) => c.includes("xuân hè") || c.includes("xuan he") || c.includes("hè"));
  const winter = names.some((c) => c.includes("thu đông") || c.includes("thu dong") || c.includes("đông"));
  if (summer && !winter) return month >= 10 || month <= 2;
  if (winter && !summer) return month >= 4 && month <= 8;
  return false;
}

export function daysOfStock(i: Pick<ClassInput, "stock" | "dailySales">): number | null {
  if (i.stock == null) return null;
  if (i.stock <= 0) return 0;
  return i.dailySales > 0 ? i.stock / i.dailySales : Infinity;
}

/** Phân nhóm tự động. Thứ tự: Mới → Xả kho → Chủ lực → Thường. */
export function classify(i: ClassInput, p: RuleParams): { cls: ProductClass; reason: string } {
  const dos = daysOfStock(i);
  const dosText = dos == null ? "" : dos === Infinity ? "không bán được" : `đủ bán ${Math.round(dos)} ngày`;
  if (i.ageDays != null && i.ageDays < p.new_days) {
    return { cls: "moi", reason: `Sản phẩm mới ${Math.round(i.ageDays)} ngày` };
  }
  if (i.stock != null && i.stock >= p.clear_min_stock) {
    if (dos != null && dos >= p.clear_stock_days) {
      return { cls: "xa_kho", reason: `Tồn ${i.stock}, ${dosText}` };
    }
    if (outOfSeason(i.categories, i.month)) {
      return { cls: "xa_kho", reason: `Trái mùa (${[...i.categories].join(", ")}), tồn ${i.stock}` };
    }
  }
  if (
    i.units30 >= p.core_min_units &&
    i.costRatio != null &&
    i.costRatio * 100 <= p.core_max_cost_pct &&
    (dos == null || dos >= p.core_min_stock_days)
  ) {
    return { cls: "chu_luc", reason: `Bán ${i.units30}/30 ngày, giá vốn ${Math.round(i.costRatio * 100)}%${dosText ? `, ${dosText}` : ""}` };
  }
  return { cls: "thuong", reason: `Bán ${i.units30}/30 ngày${dosText ? `, ${dosText}` : ""}` };
}

/** Các số kinh tế cần để tính ROAS mục tiêu theo nhóm (lấy từ econ đã lưu). */
export interface EconBase {
  margin: number;
  cancel_rate: number;
  return_rate: number;
  payout: number;
  return_fee_ratio?: number;
  ad_fee_pct?: number;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * ROAS mục tiêu (theo chi Shopee báo) của một nhóm:
 *   Chủ lực / Thường / Mới: lãi mong muốn riêng của nhóm (như ROAS theo lãi).
 *   Xả kho: lãi clear_profit_pct (âm = chấp nhận lỗ tối đa N% để đẩy hàng; anh chốt 12/11: lỗ tối đa 5%).
 */
export function targetForClass(e: EconBase, cls: ProductClass, p: RuleParams): { target: number | null; label: string } {
  if (cls === "xa_kho") {
    const pct = p.clear_profit_pct;
    return profitTarget(e, pct, `xả kho: ${pct < 0 ? `lỗ tối đa ${-pct}%` : pct > 0 ? `lãi ${pct}%` : "hòa vốn"}`);
  }
  const pct = cls === "chu_luc" ? p.profit_core_pct : cls === "moi" ? p.profit_new_pct : p.profit_target_pct;
  return profitTarget(e, pct, `${CLASS_VI[cls].toLowerCase()}: ${pct > 0 ? `lãi ${pct}%` : "hòa vốn"}`);
}

/**
 * Sàn lãi toàn hệ thống: trả lý do không được tăng (hoặc null). Gần sàn thì dừng nhóm lãi mỏng trước:
 *   < sàn + 2 điểm: dừng Xả kho;  < sàn + 1: dừng thêm Mới;  < sàn: chỉ mã tự nó đang lãi ≥ sàn mới được tăng.
 * Thêm trần tỷ trọng chi trong ngày cho Xả kho và Mới.
 */
export function floorBlock(
  cls: ProductClass | undefined,
  sysPct: number | null,
  ownPct: number | null,
  share: Partial<Record<ProductClass, number>>,
  p: RuleParams
): string | null {
  const floor = p.system_profit_floor_pct;
  if (cls === "xa_kho" && (share.xa_kho ?? 0) * 100 >= p.clear_max_spend_share_pct) return `Xả kho đã chiếm ${Math.round((share.xa_kho ?? 0) * 100)}% chi hôm nay (trần ${p.clear_max_spend_share_pct}%)`;
  if (cls === "moi" && (share.moi ?? 0) * 100 >= p.new_max_spend_share_pct) return `Hàng mới đã chiếm ${Math.round((share.moi ?? 0) * 100)}% chi hôm nay (trần ${p.new_max_spend_share_pct}%)`;
  if (sysPct == null || !(floor > 0)) return null;
  const sys = `lãi chung ${sysPct.toFixed(1)}%`;
  if (sysPct < floor) return ownPct != null && ownPct >= floor ? null : `${sys} dưới sàn ${floor}%, mã này lãi ${ownPct == null ? "?" : ownPct.toFixed(1)}%`;
  if (sysPct < floor + 1 && (cls === "xa_kho" || cls === "moi")) return `${sys} sát sàn ${floor}%`;
  if (sysPct < floor + 2 && cls === "xa_kho") return `${sys} gần sàn ${floor}%`;
  return null;
}

/** Nhóm được thử bậc lãi (cải tiến liên tục): Ngôi sao và Bò sữa. */
export function stepsClass(cls: ProductClass | undefined | null): boolean {
  return cls === "chu_luc" || cls === "thuong";
}

/**
 * Mục tiêu của chiến dịch khi có bậc lãi riêng (thử bậc đã chọn / đang thử) thay cho lãi cố định của nhóm.
 * Dùng cho cả ROAS mục tiêu Shopee lẫn ngưỡng tăng ngân sách.
 */
export function levelTarget(e: EconBase, cls: ProductClass, levelPct: number): { target: number | null; label: string } {
  return profitTarget(e, levelPct, `${CLASS_VI[cls].toLowerCase()} (${CLASS_BCG[cls].toLowerCase()}): bậc lãi ${levelPct}%`);
}

export function profitTarget(e: EconBase, pct: number, label: string): { target: number | null; label: string } {
  const fee = 1 + (e.ad_fee_pct ?? 0) / 100;
  const keepC = 1 - e.cancel_rate;
  const allow = e.margin - keepC * (1 - e.return_rate) * (pct / 100);
  return { target: allow > 0 ? round1(fee / allow) : null, label };
}

/**
 * Ngưỡng ROAS để TĂNG ngân sách theo nhóm:
 *   Ngôi sao (Chủ lực): lãi ≥ scale_core_profit_pct (mặc định 10%: vừa bán nhiều vừa lãi tốt), tăng nhanh hơn.
 *   Bò sữa (Thường), Dấu hỏi (Mới), Chó (Xả kho): đúng mục tiêu của nhóm (10% / hòa vốn / lỗ tối đa 5%).
 * Không có số kinh tế thì null (luật dùng ngưỡng thường).
 */
export function scaleTargetFor(
  e: (EconBase & { class?: ProductClass; target?: number | null; level_pct?: number | null }) | null,
  p: RuleParams
): { target: number | null; label: string } | null {
  if (!e?.margin) return null;
  const cls = (e.class ?? "thuong") as ProductClass;
  // Có bậc lãi riêng (thử bậc): tăng ngân sách theo đúng bậc đó.
  if (e.level_pct != null && stepsClass(cls)) return levelTarget(e, cls, Number(e.level_pct));
  if (cls === "chu_luc" && p.scale_core_profit_pct !== p.profit_core_pct) {
    return profitTarget(e, p.scale_core_profit_pct, `chủ lực (ngôi sao): tăng khi lãi ≥ ${p.scale_core_profit_pct}%`);
  }
  const own = targetForClass(e, cls, p);
  return { target: own.target, label: `${CLASS_VI[cls].toLowerCase()} (${CLASS_BCG[cls].toLowerCase()}): ${own.label.split(": ").slice(1).join(": ")}` };
}
