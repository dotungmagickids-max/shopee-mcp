/** Tồn kho của các mã hàng được hỏi, gộp từ tồn theo phân loại của trang Kho. Hàm thuần. */

export interface TonMa {
  /** Tổng tồn thực của mọi phân loại. */
  ton: number;
  phanLoai: number;
  /** Số phân loại đã hết (tồn ≤ 0). */
  het: number;
  /** Số đơn đang chờ hàng. */
  choHang: number;
}

/** Dòng tồn của trang Kho: [mã phân loại, tồn thực, tên, mã hàng, đơn đang chờ hàng]. */
export function tonTheoMa(ma: string[], stock: ReadonlyArray<readonly [string, number, string, string, number?]>): Record<string, TonMa> {
  const can = new Set(ma.filter((m) => !m.startsWith("#")).map((m) => m.toUpperCase()));
  const out: Record<string, TonMa> = {};
  if (!can.size) return out;
  for (const r of stock) {
    const m = String(r[3] ?? "").toUpperCase();
    if (!can.has(m)) continue;
    const t = (out[m] ??= { ton: 0, phanLoai: 0, het: 0, choHang: 0 });
    const q = Number(r[1]) || 0;
    t.ton += q;
    t.phanLoai += 1;
    if (q <= 0) t.het += 1;
    t.choHang += Number(r[4]) || 0;
  }
  return out;
}
