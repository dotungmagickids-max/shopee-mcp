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
 *   Xả kho: giá vốn coi như đã chi; tiền mặt thu về trên 1đ GMV = (1 − hủy) × (tiền về × (1 − hoàn) − phí hoàn),
 *           quảng cáo được dùng tối đa clear_ads_share_pct% số đó.
 */
export function targetForClass(e: EconBase, cls: ProductClass, p: RuleParams): { target: number | null; label: string } {
  const fee = 1 + (e.ad_fee_pct ?? 0) / 100;
  const keepC = 1 - e.cancel_rate;
  if (cls === "xa_kho") {
    const cash = keepC * (e.payout * (1 - e.return_rate) - (e.return_fee_ratio ?? 0));
    const allow = cash * (p.clear_ads_share_pct / 100);
    return { target: allow > 0 ? round1(fee / allow) : null, label: `xả kho: QC ≤ ${p.clear_ads_share_pct}% tiền thu về` };
  }
  const pct = cls === "chu_luc" ? p.profit_core_pct : cls === "moi" ? p.profit_new_pct : p.profit_target_pct;
  return profitTarget(e, pct, `${CLASS_VI[cls].toLowerCase()}: ${pct > 0 ? `lãi ${pct}%` : "hòa vốn"}`);
}

function profitTarget(e: EconBase, pct: number, label: string): { target: number | null; label: string } {
  const fee = 1 + (e.ad_fee_pct ?? 0) / 100;
  const keepC = 1 - e.cancel_rate;
  const allow = e.margin - keepC * (1 - e.return_rate) * (pct / 100);
  return { target: allow > 0 ? round1(fee / allow) : null, label };
}

/**
 * Ngưỡng ROAS để TĂNG ngân sách theo nhóm:
 *   Ngôi sao (Chủ lực): lãi ≥ scale_core_profit_pct (mặc định 10%: vừa bán nhiều vừa lãi tốt), tăng nhanh hơn.
 *   Bò sữa (Thường), Dấu hỏi (Mới), Chó (Xả kho): đúng mục tiêu của nhóm (10% / hòa vốn / QC ≤ 60% tiền thu).
 * Không có số kinh tế thì null (luật dùng ngưỡng thường).
 */
export function scaleTargetFor(e: (EconBase & { class?: ProductClass; target?: number | null }) | null, p: RuleParams): { target: number | null; label: string } | null {
  if (!e?.margin) return null;
  const cls = (e.class ?? "thuong") as ProductClass;
  if (cls === "chu_luc" && p.scale_core_profit_pct !== p.profit_core_pct) {
    return profitTarget(e, p.scale_core_profit_pct, `chủ lực (ngôi sao): tăng khi lãi ≥ ${p.scale_core_profit_pct}%`);
  }
  const own = targetForClass(e, cls, p);
  return { target: own.target, label: `${CLASS_VI[cls].toLowerCase()} (${CLASS_BCG[cls].toLowerCase()}): ${own.label.split(": ").slice(1).join(": ")}` };
}
