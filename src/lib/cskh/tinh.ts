/**
 * Quản lý chất lượng CSKH: tính số của một ngày từ các tin đã đồng bộ. Hàm thuần, không gọi mạng, để test.
 * Không có tên, SĐT hay nội dung tin của khách ở đây: mỗi tin chỉ còn giờ gửi, bên gửi, độ dài, mã hàng nhắc tới.
 *
 * Định nghĩa (anh Tùng chốt 23/11/2026, các số nằm trong CauHinh để đổi được):
 *   - Chốt: cuộc chat có đơn POS (không hủy) tạo trong 48 giờ kể từ tin đầu tiên trong ngày, khớp hội thoại hoặc SĐT.
 *   - Tin sót: tin khách đến hết ca (sáng, chiều, tối) vẫn chưa có người trả lời. Tin ngoài giờ tính vào ca sáng kế tiếp.
 *   - Shop nhắn lại khách cũ: hội thoại cũ mà trong ngày shop nhắn trước. Khách không trả lời thì loại khỏi số đếm;
 *     khách trả lời thì vào nhóm "khách cũ phản hồi".
 */

export type Ben = "khach" | "nhan_vien" | "tu_dong";
export type LoaiTin = "chu" | "anh" | "sticker" | "khac" | "rong";

export interface Tin {
  id: string;
  /** Giờ gửi, mili giây unix. */
  luc: number;
  ben: Ben;
  /** Tên nhân viên gửi (chỉ khi ben = nhan_vien). */
  nv?: string;
  kyTu: number;
  loai: LoaiTin;
  /** Mã hàng và nhóm hàng nhắc tới trong tin (nhóm hàng có dấu # ở đầu). */
  ma?: string[];
  /** Dấu băm của phần chữ, để nhận ra tin mẫu gửi giống nhau cho nhiều khách. Không đọc ngược ra chữ được. */
  bam?: string;
}

export interface HoiThoai {
  page: string;
  id: string;
  /** INBOX hoặc COMMENT. */
  loai: string;
  taoLuc: number;
  the: string[];
  coSdt: boolean;
  tin: Tin[];
}

export interface DonKhop {
  page: string;
  hoiThoai: string;
  ma: string;
  taoLuc: number;
}

export interface Ca {
  ten: string;
  /** Giờ bắt đầu và kết thúc theo giờ Việt Nam (0–24). */
  tu: number;
  den: number;
}

export interface CauHinh {
  ca: Ca[];
  /** Số giờ kể từ tin đầu để đơn POS được tính là chốt. */
  chotGio: number;
  /** Tin đến sát cuối ca vẫn có ít nhất chừng này phút để trả lời trước khi tính là sót. */
  toiThieuPhut: number;
  /** Một tin nhân viên giống hệt nhau ở từ chừng này cuộc trở lên trong ngày thì coi là tin mẫu. */
  nguongMau: number;
}

/** Giờ ca là số đặt tạm, chờ anh xác nhận. */
export const MAC_DINH: CauHinh = {
  ca: [
    { ten: "sáng", tu: 8, den: 12 },
    { ten: "chiều", tu: 12, den: 18 },
    { ten: "tối", tu: 18, den: 22 },
  ],
  chotGio: 48,
  toiThieuPhut: 15,
  nguongMau: 5,
};

const GIO = 3_600_000;
const NGAY = 24 * GIO;
const VN = 7 * GIO;

export const dauNgay = (ngay: string): number => Date.parse(`${ngay}T00:00:00+07:00`);
export const gioVN = (ms: number): number => new Date(ms + VN).getUTCHours();
const dauNgayCua = (ms: number): number => Math.floor((ms + VN) / NGAY) * NGAY - VN;

/** Hạn trả lời của một tin khách: hết ca chứa tin đó; ngoài giờ thì hết ca đầu tiên kế tiếp. */
export function hanTraLoi(luc: number, ch: CauHinh = MAC_DINH): { han: number; ca: string } {
  const d0 = dauNgayCua(luc);
  const gio = (luc - d0) / GIO;
  const toiThieu = luc + ch.toiThieuPhut * 60_000;
  const dau = ch.ca[0];
  const cuoi = ch.ca[ch.ca.length - 1];
  if (gio >= cuoi.den) return { han: Math.max(d0 + NGAY + dau.den * GIO, toiThieu), ca: dau.ten };
  const c = ch.ca.find((x) => gio < x.den) ?? cuoi;
  return { han: Math.max(d0 + c.den * GIO, toiThieu), ca: c.ten };
}

export function trungVi(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Mốc mà 90% số lần trả lời nhanh hơn. */
export function moc90(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)];
}

export type Nhom = "khach_moi" | "moi_tu_binh_luan" | "khach_cu" | "khach_cu_phan_hoi" | "shop_nhan";

export interface So {
  /** Cuộc chat được tính (không gồm cuộc shop nhắn mà khách không trả lời). */
  cuoc: number;
  khachMoi: number;
  khachCu: number;
  khachCuPhanHoi: number;
  /** Cuộc shop nhắn lại khách cũ, khách không trả lời: đã loại. */
  shopNhan: number;
  tinKhach: number;
  tinNhanVien: number;
  tinTuDong: number;
  /** Tin shop gửi trước cho khách cũ: đã loại khỏi tinNhanVien và tinTuDong. */
  tinNhanLai: number;
  coSdt: number;
  binhLuan: number;
  chotMoi: number;
  chotCu: number;
  sot: number;
  sotConTreo: number;
}

export interface DongNguoiTruc {
  ten: string;
  cuoc: number;
  tin: number;
  /** Trả lời đầu trong giờ trực, tính bằng giây. */
  trungViGiay: number | null;
  moc90Giay: number | null;
  chamNhatGiay: number | null;
  /** Số lượt khách nhắn ngoài giờ trực mà người này trả lời (không tính vào trung vị). */
  ngoaiGio: number;
  chot: number;
  khachMoi: number;
  chiDanMau: number;
  traLoiTre: number;
}

export interface DongSot {
  duoi: string;
  page: string;
  luc: number;
  han: number;
  traLoi: number | null;
  ca: string;
  nguoi: string | null;
}

export interface DongCuoc {
  duoi: string;
  page: string;
  nhom: Nhom;
  nguoi: string | null;
  giay: number | null;
  trongGio: boolean;
  chot: boolean;
  sot: number;
  tinKhach: number;
  tinNhanVien: number;
}

export interface KetQuaNgay {
  ngay: string;
  tinhLuc: number;
  /** Chưa đủ 48 giờ sau ngày đó nên số chốt còn tăng. */
  tamTinh: boolean;
  cauHinh: CauHinh;
  tong: So;
  pages: Array<So & { page: string }>;
  theoGio: { khach: number[]; nhanVien: number[] };
  nguoiTruc: DongNguoiTruc[];
  ma: Array<{ ma: string; cuoc: number }>;
  the: Array<{ the: string; cuoc: number }>;
  sot: DongSot[];
  cuoc: DongCuoc[];
}

const soRong = (): So => ({ cuoc: 0, khachMoi: 0, khachCu: 0, khachCuPhanHoi: 0, shopNhan: 0, tinKhach: 0, tinNhanVien: 0, tinTuDong: 0, tinNhanLai: 0, coSdt: 0, binhLuan: 0, chotMoi: 0, chotCu: 0, sot: 0, sotConTreo: 0 });
const duoi = (id: string) => id.slice(-5);
const CHUA_AI = "(chưa ai trả lời)";

export function tinhNgay(ds: HoiThoai[], dons: DonKhop[], ngay: string, ch: CauHinh = MAC_DINH, now = Date.now()): KetQuaNgay {
  const d0 = dauNgay(ngay);
  const d1 = d0 + NGAY;
  const trongNgay = (t: Tin) => t.luc >= d0 && t.luc < d1;
  const gioDau = ch.ca[0].tu;
  const gioCuoi = ch.ca[ch.ca.length - 1].den;
  const trongGioTruc = (ms: number) => gioVN(ms) >= gioDau && gioVN(ms) < gioCuoi;

  const donTheo = new Map<string, DonKhop[]>();
  for (const d of dons) {
    const k = `${d.page}|${d.hoiThoai}`;
    donTheo.set(k, [...(donTheo.get(k) ?? []), d]);
  }

  // Tin mẫu: cùng một dấu băm, do nhân viên gửi, có ở nhiều cuộc trong ngày.
  const noiCoBam = new Map<string, Set<string>>();
  for (const h of ds) for (const t of h.tin) if (t.bam && t.ben === "nhan_vien" && trongNgay(t)) noiCoBam.set(t.bam, (noiCoBam.get(t.bam) ?? new Set()).add(`${h.page}|${h.id}`));
  const laMau = (t: Tin) => !!t.bam && (noiCoBam.get(t.bam)?.size ?? 0) >= ch.nguongMau;

  const tong = soRong();
  const theoPage = new Map<string, So>();
  const theoGio = { khach: Array<number>(24).fill(0), nhanVien: Array<number>(24).fill(0) };
  const nguoi = new Map<string, DongNguoiTruc & { giay: number[] }>();
  const dongNguoi = (ten: string) => {
    let r = nguoi.get(ten);
    if (!r) nguoi.set(ten, (r = { ten, cuoc: 0, tin: 0, trungViGiay: null, moc90Giay: null, chamNhatGiay: null, ngoaiGio: 0, chot: 0, khachMoi: 0, chiDanMau: 0, traLoiTre: 0, giay: [] }));
    return r;
  };
  const maCuoc = new Map<string, number>();
  const theCuoc = new Map<string, number>();
  const sot: DongSot[] = [];
  const cuoc: DongCuoc[] = [];

  for (const h of ds) {
    const tin = [...h.tin].sort((a, b) => a.luc - b.luc || a.id.localeCompare(b.id));
    const ngayTin = tin.filter(trongNgay);
    if (!ngayTin.length) continue;
    let p = theoPage.get(h.page);
    if (!p) theoPage.set(h.page, (p = soRong()));
    const cong = (f: (s: So) => void) => (f(tong), f(p!));

    if (h.loai !== "INBOX") {
      cong((s) => (s.binhLuan += 1));
      continue;
    }
    const khach = ngayTin.filter((t) => t.ben === "khach");
    const moi = h.taoLuc >= d0 && h.taoLuc < d1;
    const nhom: Nhom = !khach.length ? (moi ? "moi_tu_binh_luan" : "shop_nhan") : moi ? "khach_moi" : ngayTin[0].ben === "khach" ? "khach_cu" : "khach_cu_phan_hoi";

    // Tin shop gửi trước cho khách cũ (trước tin khách đầu tiên trong ngày) không tính vào lượng tin của shop.
    const mocKhach = khach[0]?.luc ?? Infinity;
    const nhanLai = (t: Tin) => !moi && t.ben !== "khach" && ngayTin[0].ben !== "khach" && t.luc < mocKhach;
    for (const t of ngayTin) {
      if (nhanLai(t)) cong((s) => (s.tinNhanLai += 1));
      else if (t.ben === "khach") (cong((s) => (s.tinKhach += 1)), (theoGio.khach[gioVN(t.luc)] += 1));
      else if (t.ben === "nhan_vien") (cong((s) => (s.tinNhanVien += 1)), (theoGio.nhanVien[gioVN(t.luc)] += 1), (dongNguoi(t.nv || "(không tên)").tin += 1));
      else cong((s) => (s.tinTuDong += 1));
    }
    if (nhom === "shop_nhan") {
      cong((s) => (s.shopNhan += 1));
      continue;
    }

    const laMoi = nhom === "khach_moi" || nhom === "moi_tu_binh_luan";
    cong((s) => {
      s.cuoc += 1;
      if (laMoi) s.khachMoi += 1;
      else if (nhom === "khach_cu") s.khachCu += 1;
      else s.khachCuPhanHoi += 1;
      if (h.coSdt) s.coSdt += 1;
    });
    for (const m of new Set(ngayTin.flatMap((t) => t.ma ?? []))) maCuoc.set(m, (maCuoc.get(m) ?? 0) + 1);
    for (const t of new Set(h.the)) theCuoc.set(t, (theCuoc.get(t) ?? 0) + 1);

    // Trả lời đầu: từ tin khách đầu tiên trong ngày đến tin đầu tiên của nhân viên sau đó (có thể sang hôm sau).
    const traLoi = khach.length ? tin.find((t) => t.ben === "nhan_vien" && t.luc > khach[0].luc) : undefined;
    const nvNgay = ngayTin.filter((t) => t.ben === "nhan_vien");
    const ten = traLoi?.nv ?? nvNgay[nvNgay.length - 1]?.nv ?? null;
    const giay = traLoi ? Math.round((traLoi.luc - khach[0].luc) / 1000) : null;
    const trongGio = khach.length ? trongGioTruc(khach[0].luc) : false;
    const dong = dongNguoi(ten ?? CHUA_AI);
    dong.cuoc += 1;
    if (laMoi) dong.khachMoi += 1;
    if (giay != null) {
      if (trongGio) dong.giay.push(giay);
      else dong.ngoaiGio += 1;
    }

    // Chốt: đơn POS khớp cuộc này, tạo trong chotGio giờ kể từ tin đầu tiên trong ngày.
    const moc = ngayTin[0].luc;
    const chot = (donTheo.get(`${h.page}|${h.id}`) ?? []).some((d) => d.taoLuc >= moc && d.taoLuc <= moc + ch.chotGio * GIO);
    if (chot) {
      cong((s) => (laMoi ? (s.chotMoi += 1) : (s.chotCu += 1)));
      dong.chot += 1;
    }

    // Chỉ dán mẫu rồi dừng: khách mới, không chốt, mọi tin có chữ của nhân viên đều là tin mẫu.
    const coChu = nvNgay.filter((t) => t.kyTu > 0);
    if (nhom === "khach_moi" && !chot && coChu.length > 0 && coChu.every(laMau)) dong.chiDanMau += 1;

    // Tin sót: mỗi lượt khách chờ bắt đầu trong ngày, đến hạn (hết ca) chưa có nhân viên trả lời.
    let soSot = 0;
    let cho: { luc: number; chiSticker: boolean } | null = null;
    const xet = (c: { luc: number; chiSticker: boolean }, tl: Tin | null) => {
      if (c.luc < d0 || c.luc >= d1 || c.chiSticker) return;
      const { han, ca } = hanTraLoi(c.luc, ch);
      if (tl ? tl.luc <= han : now <= han) return;
      soSot += 1;
      sot.push({ duoi: duoi(h.id), page: h.page, luc: c.luc, han, traLoi: tl?.luc ?? null, ca, nguoi: tl?.nv ?? null });
      cong((s) => ((s.sot += 1), tl ? 0 : (s.sotConTreo += 1)));
      if (tl?.nv) dongNguoi(tl.nv).traLoiTre += 1;
    };
    for (const t of tin) {
      if (t.luc < d0) continue;
      if (t.ben === "khach") {
        if (!cho) cho = { luc: t.luc, chiSticker: t.loai === "sticker" };
        else if (t.loai !== "sticker") cho.chiSticker = false;
      } else if (t.ben === "nhan_vien" && cho) {
        xet(cho, t);
        cho = null;
      }
    }
    if (cho) xet(cho, null);

    cuoc.push({ duoi: duoi(h.id), page: h.page, nhom, nguoi: ten, giay, trongGio, chot, sot: soSot, tinKhach: khach.length, tinNhanVien: nvNgay.length });
  }

  const nguoiTruc = [...nguoi.values()]
    .map(({ giay, ...r }) => ({ ...r, trungViGiay: trungVi(giay), moc90Giay: moc90(giay), chamNhatGiay: giay.length ? Math.max(...giay) : null }))
    .filter((r) => r.cuoc || r.tin)
    .sort((a, b) => b.cuoc - a.cuoc || a.ten.localeCompare(b.ten));
  const xep = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return {
    ngay,
    tinhLuc: now,
    tamTinh: now < d1 + ch.chotGio * GIO,
    cauHinh: ch,
    tong,
    pages: [...theoPage.entries()].map(([page, s]) => ({ page, ...s })).sort((a, b) => b.tinKhach - a.tinKhach || a.page.localeCompare(b.page)),
    theoGio,
    nguoiTruc,
    ma: xep(maCuoc).slice(0, 50).map(([ma, n]) => ({ ma, cuoc: n })),
    the: xep(theCuoc).map(([the, n]) => ({ the, cuoc: n })),
    sot: sot.sort((a, b) => a.luc - b.luc),
    cuoc,
  };
}

/** Dòng gọn của một ngày cho biểu đồ xu hướng. */
export function tomTat(k: KetQuaNgay) {
  const giay = k.cuoc.filter((c) => c.giay != null && c.trongGio).map((c) => c.giay as number);
  return { ngay: k.ngay, tamTinh: k.tamTinh, cuoc: k.tong.cuoc, khachMoi: k.tong.khachMoi, tinKhach: k.tong.tinKhach, chotMoi: k.tong.chotMoi, sot: k.tong.sot, trungViGiay: trungVi(giay) };
}
