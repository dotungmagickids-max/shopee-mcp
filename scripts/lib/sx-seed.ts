/**
 * Nạp số đầu cho Sổ hàng xưởng từ file SX (Google Sheet), tab "Phiếu lô cắt" và "Giao hàng về kho".
 * Phần này thuần: đọc bảng → kế hoạch nạp + cảnh báo. Không gọi mạng. Script chạy ở scripts/sx-nap-so-dau.ts.
 * KHÔNG dùng tab "Tiến độ SX" (số ở đó đã biết là sai, vd ADT25003).
 */
import { tinhLo, type HangVe, type LoCat, type TienDoLo } from "../../src/lib/san-xuat";

export type Bang = string[][];

/** Đọc CSV (RFC 4180: ô có dấu phẩy/xuống dòng nằm trong ngoặc kép, "" là một dấu ngoặc kép). */
export function docCsv(text: string): Bang {
  const rows: Bang = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Nhận CSV, hoặc JSON dạng mảng các dòng, hoặc { values: [[…]] } như Sheets API trả về. */
export function docBang(text: string, tenFile: string): Bang {
  if (tenFile.toLowerCase().endsWith(".json")) {
    const j = JSON.parse(text.replace(/^﻿/, ""));
    const v = Array.isArray(j) ? j : j.values;
    if (!Array.isArray(v)) throw new Error(`${tenFile}: JSON phải là mảng các dòng hoặc { values: [...] }`);
    return v.map((r: unknown[]) => (r ?? []).map((x) => (x == null ? "" : String(x))));
  }
  return docCsv(text);
}

const o = (r: string[], i: number) => (i < 0 ? "" : (r[i] ?? "").trim());

/** "1.234" / "1,234" / "12" → số nguyên; trống hoặc không phải số → null. */
export function so(s: string): number | null {
  const t = s.trim().replace(/[.,\s](?=\d{3}\b)/g, "");
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** dd/mm/yyyy → yyyy-mm-dd; sai dạng → null. */
export function ngayIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
}

export interface LoNap {
  ma_hang: string;
  lo: string;
  ngay_cat: string | null;
  hen_tra: string | null;
  trang_thai: "dang_ve" | "chua_doi_soat";
  ghi_chu: string | null;
  dot_dat: string | null;
  lines: { mau: string; size: string; so_cat: number }[];
  nguon: string;
  /** "Đã về kho (tự tính)" trong sheet theo màu, để so với số kho đếm. */
  sheetDaVe: Record<string, number>;
}

export interface PhieuNap {
  ma_hang: string;
  dot: string;
  ngay_dat: string | null;
  trang_thai: "cho_cat" | "da_cat";
  ghi_chu: string | null;
  lines: { mau: string; size: string; so_luong: number }[];
  nguon: string;
}

export interface VeNap {
  ma_hang: string;
  lo: string;
  ngay: string;
  nguoi_ky: string | null;
  pancake: string | null;
  ghi_chu: string | null;
  lines: { mau: string; size: string; xuong_giao: number | null; kho_dem: number | null }[];
  nguon: string;
}

export interface KeHoach {
  los: LoNap[];
  phieu: PhieuNap[];
  hangVe: VeNap[];
  /** Chỗ lệch, chỗ bị bỏ qua: Thu Hà đối chiếu với file SX trước khi nạp thật. */
  canhBao: string[];
}

const khoaLo = (ma: string, lo: string) => `${ma.toUpperCase()}|${lo}`;

function timCot(bang: Bang, can: string): { dau: number; cot: (ten: string) => number; tieuDe: string[] } {
  const dau = bang.findIndex((r) => r.some((c) => c.trim() === can));
  if (dau < 0) throw new Error(`Không thấy dòng tiêu đề có cột "${can}"`);
  const tieuDe = bang[dau].map((c) => c.trim());
  return { dau, tieuDe, cot: (ten) => tieuDe.findIndex((c) => c === ten || c.startsWith(ten)) };
}

/** Tab "Phiếu lô cắt": mỗi lô × màu một dòng, các cột size là tiêu đề toàn số (130…180). */
export function docLoCat(bang: Bang, tenTab = "Phiếu lô cắt"): Pick<KeHoach, "los" | "phieu" | "canhBao"> {
  const { dau, tieuDe, cot } = timCot(bang, "Mã hàng");
  const c = {
    ma: cot("Mã hàng"),
    lo: cot("Lô"),
    mau: cot("Màu"),
    dat: cot("SL đặt"),
    lenDon: cot("Lên đơn"),
    ngayCat: cot("Ngày cắt"),
    hen: cot("Giao kho dự kiến"),
    daVe: cot("Đã về kho"),
    ghiChu: cot("Ghi chú"),
  };
  const sizes = tieuDe.map((t, i) => ({ t, i })).filter((x) => /^\d{2,3}$/.test(x.t));
  if (c.lo < 0 || c.mau < 0 || !sizes.length) throw new Error(`${tenTab}: thiếu cột Lô, Màu hoặc các cột size`);

  const los = new Map<string, LoNap & { dong: number[]; dat: { mau: string; so: number }[]; lenDon: string | null }>();
  const canhBao: string[] = [];
  bang.slice(dau + 1).forEach((r, k) => {
    const dong = dau + 2 + k; // số dòng trong sheet (từ 1)
    const ma = o(r, c.ma).toUpperCase();
    const lo = o(r, c.lo);
    if (!ma || !lo) return;
    const key = khoaLo(ma, lo);
    let L = los.get(key);
    if (!L) {
      L = {
        ma_hang: ma, lo, ngay_cat: null, hen_tra: null, trang_thai: "dang_ve", ghi_chu: null, dot_dat: null,
        lines: [], nguon: "", sheetDaVe: {}, dong: [], dat: [], lenDon: null,
      };
      los.set(key, L);
    }
    L.dong.push(dong);
    const mau = o(r, c.mau);
    const ngayCat = ngayIso(o(r, c.ngayCat));
    const hen = ngayIso(o(r, c.hen));
    L.ngay_cat ??= ngayCat;
    if (hen && L.hen_tra && hen !== L.hen_tra) {
      canhBao.push(`${tenTab} dòng ${dong}: ${ma} ${lo} màu ${mau} hẹn ${o(r, c.hen)}, khác ngày hẹn của màu trước (${L.hen_tra}). Sổ lưu một ngày hẹn cho cả lô: lấy ngày sớm nhất, ghi ngày kia vào ghi chú.`);
      if (hen < L.hen_tra) L.hen_tra = hen;
    } else L.hen_tra ??= hen;
    L.lenDon ??= ngayIso(o(r, c.lenDon));
    const gc = o(r, c.ghiChu);
    if (gc) L.ghi_chu = [L.ghi_chu, `${mau}: ${gc}`].filter(Boolean).join(" | ").slice(0, 2000);
    const dat = so(o(r, c.dat));
    if (dat) L.dat.push({ mau, so: dat });
    const daVe = so(o(r, c.daVe));
    if (daVe != null) L.sheetDaVe[mau.toLowerCase()] = (L.sheetDaVe[mau.toLowerCase()] ?? 0) + daVe;
    for (const s of sizes) {
      const n = so(o(r, s.i));
      if (n) {
        if (L.lines.some((x) => x.mau.toLowerCase() === mau.toLowerCase() && x.size === s.t)) {
          canhBao.push(`${tenTab} dòng ${dong}: ${ma} ${lo} trùng màu ${mau} size ${s.t}, bỏ dòng sau.`);
        } else L.lines.push({ mau, size: s.t, so_cat: n });
      }
    }
  });

  const out: LoNap[] = [];
  const phieu: PhieuNap[] = [];
  for (const L of los.values()) {
    const nguon = `file SX, tab "${tenTab}", dòng ${L.dong.join(", ")}`;
    const tongDat = L.dat.reduce((a, x) => a + x.so, 0);
    const coCat = L.lines.length > 0;
    if (tongDat > 0) {
      phieu.push({
        ma_hang: L.ma_hang, dot: L.lo, ngay_dat: L.lenDon, trang_thai: coCat ? "da_cat" : "cho_cat",
        ghi_chu: L.ghi_chu, lines: L.dat.map((x) => ({ mau: x.mau, size: "", so_luong: x.so })), nguon,
      });
    }
    if (!coCat) {
      canhBao.push(`${tenTab}: ${L.ma_hang} ${L.lo} (dòng ${L.dong.join(", ")}) chưa có số cắt → KHÔNG tạo lô${tongDat > 0 ? `, chỉ tạo phiếu đặt ${tongDat} cái` : ", và không có SL đặt nên cũng không tạo phiếu đặt"}.`);
      continue;
    }
    const { dong: _d, dat: _dat, lenDon: _l, ...lo } = L;
    out.push({ ...lo, nguon, dot_dat: tongDat > 0 ? L.lo : null });
  }
  return { los: out, phieu, canhBao };
}

/**
 * Tab "Giao hàng về kho". Cột: A ngày, B mã, C lô, D màu, E size, F xưởng giao, G kho đếm,
 * H số tính về kho, I lệch, J kho nhận, K xưởng xác nhận, L ghi chú.
 * Số đã về lấy cột G (kho đếm), không lấy cột H. Gom dòng thành lần hàng về theo (ngày, mã, lô, người kho nhận);
 * mở lần mới khi trùng màu × size hoặc ghi chú bắt đầu bằng "Phiếu".
 */
export function docHangVe(bang: Bang, los: LoNap[], tenTab = "Giao hàng về kho"): Pick<KeHoach, "hangVe" | "canhBao"> {
  const dau = bang.findIndex((r) => r.some((c) => c.trim() === "Mã hàng"));
  if (dau < 0) throw new Error(`${tenTab}: không thấy dòng tiêu đề có cột "Mã hàng"`);
  const coLo = new Map(los.map((l) => [khoaLo(l.ma_hang, l.lo), l]));
  const canhBao: string[] = [];
  const mo = new Map<string, VeNap & { dong: number[] }>();
  const xong: (VeNap & { dong: number[] })[] = [];
  const thieuLo = new Map<string, { dong: number[]; xuong: number; kho: number }>();
  const khongNgay = new Map<string, { dong: number[]; xuong: number }>();

  bang.slice(dau + 1).forEach((r, k) => {
    const dong = dau + 2 + k;
    const [ngayS, maS, lo, mau, size, fS, gS, hS, , nhan, xacNhan, ghiChu] = Array.from({ length: 12 }, (_, i) => o(r, i));
    const ma = maS.toUpperCase();
    if (!ma || !lo) return;
    const xuong = so(fS);
    const kho = so(gS);
    if (xuong == null && kho == null) {
      canhBao.push(`${tenTab} dòng ${dong}: ${ma} ${lo} ${mau} ${size} không có số xưởng giao lẫn kho đếm, bỏ qua.`);
      return;
    }
    const key = khoaLo(ma, lo);
    if (!coLo.has(key)) {
      const t = thieuLo.get(key) ?? { dong: [], xuong: 0, kho: 0 };
      t.dong.push(dong);
      t.xuong += xuong ?? 0;
      t.kho += kho ?? 0;
      thieuLo.set(key, t);
      return;
    }
    const ngay = ngayIso(ngayS);
    if (!ngay) {
      const t = khongNgay.get(key) ?? { dong: [], xuong: 0 };
      t.dong.push(dong);
      t.xuong += xuong ?? kho ?? 0;
      khongNgay.set(key, t);
      return;
    }
    if (kho != null && hS === "") {
      canhBao.push(`${tenTab} dòng ${dong}: ${ma} ${lo} ${mau} ${size} có kho đếm ${kho} nhưng cột "Số tính về kho" trống (sheet không cộng dòng này). Sổ vẫn tính ${kho} theo kho đếm: cần soát có ghi trùng với phiếu khác không.`);
    }
    if (kho != null && xuong != null && kho !== xuong) {
      canhBao.push(`${tenTab} dòng ${dong}: ${ma} ${lo} ${mau} ${size} kho đếm ${kho} khác xưởng giao ${xuong}.`);
    }
    const gk = `${ngay}|${key}|${nhan}`;
    let v = mo.get(gk);
    const trung = v?.lines.some((x) => x.mau.toLowerCase() === mau.toLowerCase() && x.size === size);
    if (!v || trung || /^phiếu/i.test(ghiChu)) {
      if (v) xong.push(v);
      v = { ma_hang: ma, lo, ngay, nguoi_ky: nhan || null, pancake: null, ghi_chu: null, lines: [], nguon: "", dong: [] };
      mo.set(gk, v);
    }
    v.lines.push({ mau, size, xuong_giao: xuong, kho_dem: kho });
    v.dong.push(dong);
    const them = [xacNhan && `Xưởng xác nhận: ${xacNhan}`, ghiChu].filter(Boolean).join(". ");
    if (them && !(v.ghi_chu ?? "").includes(them)) v.ghi_chu = [v.ghi_chu, them].filter(Boolean).join(" | ").slice(0, 2000);
  });
  xong.push(...mo.values());

  for (const [key, t] of thieuLo) {
    canhBao.push(`${tenTab}: ${key.replace("|", " ")} có hàng về (dòng ${t.dong.join(", ")}; xưởng giao ${t.xuong}, kho đếm ${t.kho}) nhưng tab Phiếu lô cắt chưa có số cắt của lô này → KHÔNG nạp các dòng này. Ghi số cắt trước rồi nạp lại.`);
  }
  for (const [key, t] of khongNgay) {
    canhBao.push(`${tenTab}: ${key.replace("|", " ")} có ${t.dong.length} dòng không có ngày giao (dòng ${t.dong.join(", ")}; ${t.xuong} cái) → KHÔNG nạp.`);
  }

  const hangVe = xong
    .sort((a, b) => a.ngay.localeCompare(b.ngay) || a.dong[0] - b.dong[0])
    .map(({ dong, ...v }) => {
      const nguon = `file SX, tab "${tenTab}", dòng ${dong.join(", ")}`;
      const m = (v.ghi_chu ?? "").match(/Pancake #(\d+)/i);
      let pancake: string | null = null;
      if (m) {
        const duDem = v.lines.every((x) => x.kho_dem != null);
        if (duDem && v.nguoi_ky) {
          pancake = m[1];
          canhBao.push(`${tenTab} dòng ${dong[0]}: ${v.ma_hang} ${v.lo} ngày ${v.ngay} lấy số phiếu Pancake #${m[1]} từ ghi chú, cần soát lại.`);
        } else {
          canhBao.push(`${tenTab} dòng ${dong[0]}: ${v.ma_hang} ${v.lo} ngày ${v.ngay} ghi chú có Pancake #${m[1]} nhưng kho chưa đếm đủ hoặc chưa có người ký → không ghi số phiếu.`);
        }
      }
      return { ...v, pancake, nguon };
    });
  return { hangVe, canhBao };
}

export function lapKeHoach(bangLoCat: Bang, bangHangVe: Bang): KeHoach {
  const a = docLoCat(bangLoCat);
  const b = docHangVe(bangHangVe, a.los);
  const canhBao = [...a.canhBao, ...b.canhBao];
  // Lô chỉ có số theo sổ xưởng, kho chưa đếm dòng nào → "chưa đối soát".
  for (const l of a.los) {
    const ve = b.hangVe.filter((v) => v.ma_hang === l.ma_hang && v.lo === l.lo);
    if (ve.length && ve.every((v) => v.lines.every((x) => x.kho_dem == null))) l.trang_thai = "chua_doi_soat";
  }
  return { los: a.los, phieu: a.phieu, hangVe: b.hangVe, canhBao };
}

/** Số sẽ hiện trên trang sau khi nạp, và chỗ lệch so với cột "Đã về kho" của sheet. */
export function duBao(kh: KeHoach, homNay: string): { tienDo: TienDoLo[]; lech: string[] } {
  const los: LoCat[] = kh.los.map((l, i) => ({
    id: i + 1, ma_hang: l.ma_hang, lo: l.lo, hen_tra: l.hen_tra, ngay_cat: l.ngay_cat, trang_thai: l.trang_thai, dong: l.lines,
  }));
  const idCua = new Map(los.map((l) => [khoaLo(l.ma_hang, l.lo), l.id]));
  const hangVe: HangVe[] = kh.hangVe.map((v, i) => ({
    id: i + 1, lo_id: idCua.get(khoaLo(v.ma_hang, v.lo))!, ngay: v.ngay, nguoi_ky: v.nguoi_ky, so_phieu_pancake: v.pancake, dong: v.lines,
  }));
  const tienDo = los.map((l) => tinhLo(l, hangVe, homNay));
  const lech: string[] = [];
  tienDo.forEach((t, i) => {
    const L = kh.los[i];
    const theoMau = new Map<string, { mau: string; kho: number; xuong: number }>();
    for (const x of t.o) {
      const m = theoMau.get(x.mau.toLowerCase()) ?? { mau: x.mau, kho: 0, xuong: 0 };
      m.kho += x.khoDem;
      m.xuong += x.xuongGiao;
      theoMau.set(x.mau.toLowerCase(), m);
      if (x.soCat === 0 && (x.khoDem > 0 || x.xuongGiao > 0)) {
        lech.push(x.size === ""
          ? `${L.ma_hang} ${L.lo}: hàng về ${x.mau} ${x.khoDem || x.xuongGiao} cái ghi không có size, trong khi số cắt có chia size → trang chỉ hiện còn nợ theo màu.`
          : `${L.ma_hang} ${L.lo}: hàng về ${x.mau} ${x.size} ${x.khoDem || x.xuongGiao} cái nhưng lô không cắt màu × size này.`);
      } else if (x.conNo < 0) {
        lech.push(`${L.ma_hang} ${L.lo}: ${x.mau} ${x.size} kho đếm ${x.khoDem} nhiều hơn số cắt ${x.soCat} (thừa ${-x.conNo}).`);
      }
    }
    for (const [k, m] of theoMau) {
      const sheet = L.sheetDaVe[k];
      if (sheet != null && sheet !== m.kho) {
        lech.push(`${L.ma_hang} ${L.lo} ${m.mau}: sheet ghi "Đã về kho" ${sheet}, cộng cột kho đếm được ${m.kho}${m.xuong !== m.kho ? ` (xưởng giao ${m.xuong})` : ""}.`);
      }
    }
  });
  return { tienDo, lech };
}
