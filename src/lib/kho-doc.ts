import { normSku } from "./autopilot/pancake";
import type { GiaoRow, HoanRow, HuyRow, StockRow, XuatOrder } from "./kho";
import type { DayDoc, KiemKe, LayLech, NhapHoan, VideoRow } from "./kho-store";

/**
 * Số của trang kho (đóng hàng, soát đơn, hàng hoàn, đơn hủy, tồn) rút gọn cho các phòng AI đọc qua MCP.
 * Hàm ở đây là hàm thuần (không gọi mạng) để test; công cụ MCP ở `kho-tools.ts` lấy dữ liệu rồi gọi các hàm này.
 * Không trả tên, SĐT, địa chỉ khách, tiền thu hộ.
 */

const VN_OFFSET = 7 * 3600_000;

/** Ngày giờ Việt Nam của một mốc ms: "YYYY-MM-DD". */
export function vnDay(ms: number): string {
  return new Date(ms + VN_OFFSET).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:mm" giờ Việt Nam. */
export function vnTime(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms + VN_OFFSET).toISOString().slice(0, 16).replace("T", " ");
}

/** Cuối ngày `ngay` (23:59:59.999 giờ VN) theo ms. */
export function endOfVnDay(ngay: string): number {
  return Date.parse(`${ngay}T00:00:00Z`) - VN_OFFSET + 86400_000 - 1;
}

export interface DaDong {
  luc: number;
  may: string | null;
  kenh: string | null;
  soat: string | null;
}

/**
 * Chỉ mục đơn đã đóng: mỗi mã in trên tem (mã quét, mã đơn, số đơn Pancake) → lần quay đóng hàng gần nhất.
 * Chỉ tính video đóng hàng (che_do "DH"), bỏ video mở hàng hoàn và video đã xóa.
 */
export function chiMucDaDong(rows: VideoRow[]): Map<string, DaDong> {
  const m = new Map<string, DaDong>();
  for (const r of rows) {
    if (r.da_xoa || r.che_do !== "DH") continue;
    const luc = Date.parse(r.bat_dau);
    if (!Number.isFinite(luc)) continue;
    const v: DaDong = { luc, may: r.may, kenh: r.kenh, soat: r.soat };
    for (const k of [r.ma, r.ma_don, r.so_don]) {
      const key = normSku(k ?? "");
      if (!key) continue;
      const old = m.get(key);
      if (!old || old.luc < luc) m.set(key, v);
    }
  }
  return m;
}

const tim = (idx: Map<string, DaDong>, codes: Array<string | null | undefined>): DaDong | null => {
  for (const c of codes) {
    const hit = idx.get(normSku(c ?? ""));
    if (hit) return hit;
  }
  return null;
};

export interface DongHangInput {
  ngay: string;
  now: number;
  video: VideoRow[];
  day: DayDoc | null;
  orders: XuatOrder[] | null;
  ordersErrors?: string[];
  tra?: string[];
  toiDa?: number;
}

/** Tóm tắt đóng hàng của một ngày: Soát đơn (đã đóng / chưa đóng), video theo kênh, đơn Shopee đến hạn hoặc quá hạn mà chưa đóng, tra mã. */
export function tomTatDongHang(inp: DongHangInput): Record<string, unknown> {
  const toiDa = inp.toiDa ?? 50;
  const idx = chiMucDaDong(inp.video);
  const out: Record<string, unknown> = {
    ngay: inp.ngay,
    doc_luc: vnTime(inp.now),
    nguon: "Phần mềm đóng hàng (sổ video máy kho + Soát đơn) và đơn chờ gửi Shopee API / Pancake",
  };

  // Video đóng hàng quay trong ngày, theo kênh.
  const trongNgay = inp.video.filter((r) => !r.da_xoa && r.che_do === "DH" && vnDay(Date.parse(r.bat_dau)) === inp.ngay);
  const theoKenh: Record<string, number> = {};
  for (const r of trongNgay) theoKenh[r.kenh || "khác"] = (theoKenh[r.kenh || "khác"] ?? 0) + 1;
  out.video_dong_hang_trong_ngay = { tong: trongNgay.length, theo_kenh: theoKenh };

  // Soát đơn: danh sách đơn chuẩn bị của ngày so với video đã đóng.
  if (inp.day) {
    const chua: Array<Record<string, unknown>> = [];
    let daDong = 0;
    for (const ma of inp.day.codes) {
      const hit = tim(idx, [ma]);
      if (hit) daDong++;
      else {
        const n = inp.day.notes[ma] ?? {};
        chua.push({ ma, ly_do: n.lyDo || null, xu_ly: n.xuLy || null });
      }
    }
    out.soat_don = {
      tong_trong_danh_sach: inp.day.codes.length,
      da_dong: daDong,
      chua_dong: chua.length,
      danh_sach_chua_dong: chua.slice(0, toiDa),
      ...(chua.length > toiDa ? { con_nua: chua.length - toiDa } : {}),
    };
  } else out.soat_don = "chưa có danh sách Soát đơn của ngày này";

  // Đơn Shopee chờ gửi: đến hạn trong ngày hoặc đã quá hạn mà chưa có video đóng.
  if (inp.orders) {
    const cuoiNgay = endOfVnDay(inp.ngay);
    const shopee = inp.orders.filter((o) => o.channel === "Shopee" && o.shipBy != null);
    const dong = (o: XuatOrder) => ({
      ma_don: o.id,
      shop: o.shop,
      han_gui: vnTime(o.shipBy),
      da_chuan_bi_hang: !!o.arranged,
      di_duoc: o.eligible,
      ly_do_chua_di: o.eligible ? null : o.reason || null,
    });
    const quaHan = shopee.filter((o) => (o.shipBy as number) < inp.now && !tim(idx, [o.id]));
    const denHan = shopee.filter((o) => (o.shipBy as number) >= inp.now && (o.shipBy as number) <= cuoiNgay && !tim(idx, [o.id]));
    out.shopee_chua_dong = {
      qua_han: quaHan.length,
      den_han_trong_ngay: denHan.length,
      danh_sach_qua_han: quaHan.slice(0, toiDa).map(dong),
      danh_sach_den_han: denHan.slice(0, toiDa).map(dong),
    };
    const choDong = inp.orders.filter((o) => !tim(idx, [o.id]));
    const kenh: Record<string, number> = {};
    for (const o of choDong) kenh[o.channel] = (kenh[o.channel] ?? 0) + 1;
    out.don_cho_dong_hien_tai = { tong: choDong.length, theo_kenh: kenh };
  } else out.shopee_chua_dong = "chưa đọc được đơn chờ gửi";
  if (inp.ordersErrors?.length) out.loi_doc_don = inp.ordersErrors;

  if (inp.tra?.length) out.tra_ma = traMa(inp.tra, idx);
  return out;
}

/** Tra từng mã (mã đơn, mã vận đơn, số đơn Pancake): đã có video đóng hàng chưa, lúc nào, máy nào. */
export function traMa(codes: string[], idx: Map<string, DaDong>): Array<Record<string, unknown>> {
  return codes.map((c) => {
    const hit = tim(idx, [c]);
    return hit
      ? { ma: normSku(c), da_dong: true, luc: vnTime(hit.luc), may: hit.may, kenh: hit.kenh, soat: hit.soat }
      : { ma: normSku(c), da_dong: false, ghi_chu: "chưa thấy video đóng hàng trong sổ" };
  });
}

/** Đơn đã hủy trên Pancake (5 ngày) mà kho đã quay video đóng: kho phải lấy lại hàng. Kèm ghi chú kho đã xử lý chưa. */
export function huySauKhiDong(rows: HuyRow[], idx: Map<string, DaDong>, marks: Record<string, Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const hit = tim(idx, [r.id, r.sys, ...r.codes]);
    if (!hit) continue;
    const m = marks[r.id] ?? marks[r.sys] ?? {};
    out.push({
      ma_don: r.id,
      so_don: r.sys || null,
      kenh: r.kenh,
      dong_luc: vnTime(hit.luc),
      huy_luc: vnTime(r.huyLuc),
      hang_da_lay: r.daLay,
      kho_ghi: (m.state as string) || "chưa ghi",
    });
  }
  return out;
}

/** Đơn Viettel Post giao có vấn đề còn mở, kèm kết quả xử lý đã ghi. */
export function giaoCoVanDe(rows: GiaoRow[], marks: Record<string, Record<string, unknown>>, toiDa = 50): Record<string, unknown> {
  const mo = rows.filter((r) => r.con);
  const xong = rows.filter((r) => !r.con);
  return {
    dang_mo: mo.length,
    chua_ghi_xu_ly: mo.filter((r) => !marks[r.ma]?.state).length,
    da_roi_danh_sach_30_ngay: { giao_duoc: xong.filter((r) => r.kq === "giao").length, hoan: xong.filter((r) => r.kq === "hoan").length },
    danh_sach: mo.slice(0, toiDa).map((r) => ({
      ma: r.ma,
      ma_don: r.id || null,
      kenh: r.channel,
      tinh_trang: r.status,
      ly_do: r.reason,
      tu_ngay: vnTime(r.since),
      xu_ly: (marks[r.ma]?.state as string) || null,
    })),
  };
}

/** Lấy hàng lệch khi đóng trong `ngay` ngày gần nhất. */
export function layLechGanDay(entries: LayLech[], now: number, ngay = 7): Array<Record<string, unknown>> {
  const tu = now - ngay * 86400_000;
  return entries
    .filter((e) => e.at >= tu)
    .sort((a, b) => b.at - a.at)
    .map((e) => ({ ma_don: e.don, lay_ma: e.sku, thay_cho: e.thay, ly_do: e.lyDo, luc: vnTime(e.at), may: e.may }));
}

/** Kiện hoàn đang về và đã về kho, gộp theo kênh và loại; kèm số lượt nhập hàng hoàn gần đây. */
export function tomTatHangHoan(returns: HoanRow[], marks: Record<string, Record<string, unknown>>, nhap: NhapHoan[], now: number, toiDa = 50): Record<string, unknown> {
  const LOAI: Record<HoanRow["kind"], string> = { "tra-hang": "khách trả hàng", "giao-that-bai": "giao thất bại", "hoan-mot-phan": "hoàn một phần" };
  const nhom: Record<string, { kien: number; cai: number }> = {};
  let veKho = 0;
  const ds = returns.map((r) => {
    const m = marks[r.key] ?? {};
    const state = (m.state as string) || null;
    if (state) veKho++;
    const k = `${r.channel} · ${LOAI[r.kind]}`;
    const cai = r.items.reduce((s, i) => s + i.quantity, 0);
    nhom[k] = { kien: (nhom[k]?.kien ?? 0) + 1, cai: (nhom[k]?.cai ?? 0) + cai };
    return {
      ma_don: r.id,
      kenh: r.channel,
      shop: r.shop,
      loai: LOAI[r.kind],
      tinh_trang: r.status,
      ly_do: r.reason,
      so_cai: cai,
      ma_hang: r.items.map((i) => `${i.sku} x${i.quantity}`).join(", "),
      tu_ngay: vnTime(r.since),
      kho_ghi: state,
    };
  });
  const tu = now - 7 * 86400_000;
  const nhap7 = nhap.filter((e) => e.at >= tu);
  return {
    kien_dang_theo_doi: returns.length,
    kho_da_ghi_tinh_trang: veKho,
    theo_nhom: nhom,
    nhap_hang_hoan_7_ngay: {
      luot: nhap7.length,
      cai_nhap: nhap7.filter((e) => e.kind === "nhap").reduce((s, e) => s + e.qty, 0),
      luot_khong_nhap: nhap7.filter((e) => e.kind === "bo").length,
    },
    danh_sach: ds.slice(0, toiDa),
    ...(ds.length > toiDa ? { con_nua: ds.length - toiDa } : {}),
  };
}

/**
 * Tồn thực Pancake gom theo mã hàng (anh chốt 22/11: trang quản lý kho chỉ hiện mã, không hiện tên sản phẩm).
 * `ma`: lọc theo mã hàng (vd ADT26001); có lọc thì trả từng phân loại.
 */
export function tomTatTon(stock: StockRow[], ma?: string[]): Record<string, unknown> {
  const loc = (ma ?? []).map((m) => normSku(m)).filter(Boolean);
  const rows = loc.length ? stock.filter(([sku, , , maHang]) => loc.some((m) => (maHang || sku).startsWith(m))) : stock;
  const theoMa = new Map<string, { ton: number; cho_hang: number; phan_loai: number; con_ton: number }>();
  for (const [sku, qty, , maHang, cho] of rows) {
    const k = maHang || sku;
    const g = theoMa.get(k) ?? { ton: 0, cho_hang: 0, phan_loai: 0, con_ton: 0 };
    g.ton += qty;
    g.cho_hang += cho;
    g.phan_loai++;
    if (qty > 0) g.con_ton++;
    theoMa.set(k, g);
  }
  const out: Record<string, unknown> = {
    phan_loai: rows.length,
    tong_ton: rows.reduce((s, r) => s + r[1], 0),
    don_dang_cho_hang: rows.reduce((s, r) => s + r[4], 0),
  };
  if (loc.length) {
    out.theo_ma = Object.fromEntries(theoMa);
    out.theo_phan_loai = rows.map(([sku, qty, , , cho]) => ({ ma: sku, ton: qty, don_cho_hang: cho }));
  } else {
    out.ma_hang = theoMa.size;
    out.ma_con_ton = [...theoMa.values()].filter((g) => g.ton > 0).length;
    out.theo_ma = Object.fromEntries([...theoMa].filter(([, g]) => g.ton !== 0 || g.cho_hang !== 0).sort((a, b) => b[1].ton - a[1].ton));
  }
  return out;
}

/** Số đếm của một đợt tổng kiểm kho, gộp theo phân loại (lượt sau cộng dồn, qty âm là lượt hủy) và so với tồn Pancake. */
export function tomTatKiemKe(entries: KiemKe[], stock: StockRow[] | null, toiDa = 100): Record<string, unknown> {
  const dem = new Map<string, number>();
  for (const e of entries) dem.set(e.sku, (dem.get(e.sku) ?? 0) + e.qty);
  const ton = new Map((stock ?? []).map((r) => [r[0], r[1]] as const));
  const lech = [...dem]
    .map(([sku, so]) => ({ ma: sku, dem: so, ton_pancake: ton.has(sku) ? ton.get(sku)! : null, lech: ton.has(sku) ? so - ton.get(sku)! : null }))
    .filter((r) => r.lech !== 0)
    .sort((a, b) => Math.abs(b.lech ?? 0) - Math.abs(a.lech ?? 0));
  return {
    luot_dem: entries.length,
    phan_loai_da_dem: dem.size,
    tong_cai_dem: [...dem.values()].reduce((s, v) => s + v, 0),
    ...(stock ? { phan_loai_lech: lech.length, lech: lech.slice(0, toiDa) } : { lech: "chưa đọc được tồn Pancake" }),
  };
}
