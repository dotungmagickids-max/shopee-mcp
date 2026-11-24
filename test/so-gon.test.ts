/** Số gọn cho báo cáo sáng (lệnh mk_so_sang): mốc giờ, nguồn, thiếu thì ghi "chưa có" chứ không ghi 0. Mọi số, mã, tên ở đây là dữ liệu giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dongCskh, dongKieuGiao, khoangNgay, linkPancake, type VaoKieuGiao } from "../src/lib/so-gon";
import { gopCham, type DongCham } from "../src/lib/cskh/cham";
import { MAC_DINH, dauNgay, tinhNgay, type HoiThoai, type Tin } from "../src/lib/cskh/tinh";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const NGAY = "2026-01-10";
const HOM_NAY = "2026-01-11";
const iso = (ngay: string, gio: string) => new Date(Date.parse(`${ngay}T${gio}:00+07:00`)).toISOString();

const vao = (them: Partial<VaoKieuGiao> = {}): VaoKieuGiao => ({
  ngay: NGAY,
  homNay: HOM_NAY,
  banNgay: [
    { ky: NGAY, kenh: "shopee_magickids", don_chot: 10, doanh_so_giu: 2_000_000, lai_truoc_qc: 600_000, lai_sau_qc: 400_000 },
    { ky: NGAY, kenh: "facebook", don_chot: 4, doanh_so_giu: 1_000_000, lai_truoc_qc: 300_000, lai_sau_qc: null },
  ],
  banThang: [
    { ky: "tong", kenh: "shopee_magickids", don_chot: 50, doanh_so_giu: 10_000_000, lai_truoc_qc: 3_000_000, lai_sau_qc: 1_500_000, don_tien_ve_uoc_tinh: 3 },
    { ky: "tong", kenh: "facebook", don_chot: 20, doanh_so_giu: 5_000_000, lai_truoc_qc: 1_000_000, lai_sau_qc: null },
  ],
  shopeeLuc: iso(HOM_NAY, "06:00"),
  pancakeDen: iso(HOM_NAY, "06:55"),
  pancakeLoi: false,
  spChi: new Map([["2026-01-01", 100_000], [NGAY, 200_000]]),
  spLuc: iso(HOM_NAY, "06:00"),
  fbChi: new Map([[NGAY, { thuong: 100_000, cpas: 50_000 }]]),
  fbLuc: iso(NGAY, "23:05"),
  ma: null,
  loi: {},
  ...them,
});

describe("số gọn Kiều Giao", () => {
  it("doanh số từng kênh kèm mốc giờ và nguồn; kênh không có dòng mà nguồn đã đủ ngày thì là 0", () => {
    const s = dongKieuGiao(vao()).join("\n");
    assert.match(s, /Shopee Magickids: 10 đơn, 2tr, lãi sau QC 400k \(20,0%\)/);
    assert.match(s, /Shopee Annie Baby: 0 đơn, 0\n/);
    assert.match(s, /TikTok: 0 đơn, 0\n/);
    assert.match(s, /lần tốt cuối 06:00 11\/01/);
    assert.doesNotMatch(s, /CHƯA ĐỦ NGÀY/);
  });
  it("Pancake chưa đồng bộ qua hết ngày: ghi CHƯA ĐỦ NGÀY, kênh không có dòng thì 'chưa có' chứ không phải 0", () => {
    const s = dongKieuGiao(vao({ pancakeDen: iso(NGAY, "06:50"), pancakeLoi: true })).join("\n");
    assert.match(s, /Facebook: 4 đơn, 1tr · CHƯA ĐỦ NGÀY/);
    assert.match(s, /TikTok: chưa có · CHƯA ĐỦ NGÀY/);
    assert.match(s, /lần đồng bộ cuối LỖI/);
    assert.match(s, /QC\/DT chưa có \(doanh thu Pancake chưa đủ ngày\)/);
  });
  it("chi Facebook bỏ CPAS khỏi kênh, nhân 1,111; tạm khi chưa qua 07:00 chốt; Shopee × 1,08", () => {
    const s = dongKieuGiao(vao()).join("\n");
    assert.match(s, /Facebook \(bỏ BOSS TUYỀN 3\/4\/5\/6 và CPAS\): 111k .*QC\/DT 11,1% · TẠM/);
    assert.match(s, /CPAS → Shopee .*: 56k/);
    assert.match(s, /Shopee Ads: 216k/);
    assert.match(s, /TikTok Ads: chưa có/);
  });
  it("tháng: MT-03 cộng cả CPAS, nêu các ngày Facebook thiếu số; MT-04, MT-07", () => {
    const s = dongKieuGiao(vao()).join("\n");
    // Shopee 300k × 1,08 = 324k; Facebook 150k × 1,111 = 167k; cộng 491k / 15tr.
    assert.match(s, /MT-03 chi QC thật tháng: 491k \(Shopee 324k, Facebook gồm CPAS 167k/);
    assert.match(s, /\/doanh số 3,3%/);
    assert.match(s, /Facebook THIẾU 9 ngày: 01\/01–09\/01\n/);
    assert.match(s, /MT-07 doanh số giữ mọi kênh: 15tr/);
    assert.match(s, /MT-04 Shopee Magickids: doanh số giữ 10tr, lãi sau QC 1,5tr \(15,0%\), 3 đơn tiền về còn ước tính/);
  });
  it("lỗi đọc thì ghi 'chưa có' kèm lý do; mã hàng chưa có số thì không cộng 0 vào chữ", () => {
    const s = dongKieuGiao(vao({ banNgay: null, fbChi: null, loi: { banNgay: "hỏng mạng", fb: "hỏng bảng" }, ma: { tu: "2025-08-01", dong: [{ ma: "MA001", sl_ban: 12 }, { ma: "MA002", sl_ban: null }] } })).join("\n");
    assert.match(s, /chưa có: hỏng mạng/);
    assert.match(s, /Facebook: chưa có \(hỏng bảng\)/);
    assert.match(s, /MA001 12; MA002 chưa có; cộng 12/);
  });
});

const PAGE = "900000000000001";
const luc = (gio: number, phut = 0) => dauNgay(NGAY) + gio * 3_600_000 + phut * 60_000;
let dem = 0;
const tin = (ms: number, ben: Tin["ben"]): Tin => ({ id: `m${++dem}`, luc: ms, ben, kyTu: 10, loai: "chu", ...(ben === "nhan_vien" ? { nv: "Nhân viên A" } : {}) });
const ht = (id: string, ms: number, ds: Tin[]): HoiThoai => ({ page: PAGE, id, loai: "INBOX", taoLuc: ms, the: [], coSdt: false, tin: ds });
const cham = (id: string, them: Partial<DongCham> = {}): DongCham => ({
  page: PAGE, id, loai: "hoi_gia_size", ketQua: "khach_im", diemSize: 8, diemMuaKem: 4, diemChot: 6, diemThaiDo: 9, sanPham: ["MA001"], tiemNang: "khong",
  lyDoTiemNang: "", diemTiemNang: null, tinGoiY: "", phanHoiXau: false, moTaXau: "", doDongHang: false, viec: "", mucGap: 2, nhanXet: "", ...them,
});

describe("khoảng ngày", () => {
  it("gộp ngày liền nhau", () => {
    assert.equal(khoangNgay(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05", "2026-01-31", "2026-02-01"]), "01/01–03/01, 05/01, 31/01–01/02");
    assert.equal(khoangNgay([]), "");
  });
});

describe("số gọn CSKH", () => {
  const ds = [
    ht("g-50001", luc(9), [tin(luc(9), "khach"), tin(luc(9, 1), "nhan_vien")]),
    ht("g-50002", luc(10), [tin(luc(10), "khach"), tin(luc(10, 2), "nhan_vien")]),
    ht("g-50003", luc(22, 30), [tin(luc(22, 30), "khach")]),
  ];
  const k = tinhNgay(ds, [{ page: PAGE, hoiThoai: "g-50002", ma: "D1", taoLuc: luc(11) }], NGAY, MAC_DINH, luc(23));
  const g = gopCham(k, [cham("g-50001", { tiemNang: "nong", diemTiemNang: 8, lyDoTiemNang: "đã cho size, hỏi giá" }), cham("g-50002", { ketQua: "da_chot" })], "model-a");

  it("tỉ lệ chốt theo page, người trực, điểm AI, khách cần chăm kèm link, cuộc chưa chấm", () => {
    const s = dongCskh({ ngay: NGAY, k, g, chamLuc: iso(NGAY, "21:40"), tenPage: { [PAGE]: "Page giả" }, chuaCham: [{ page: PAGE, id: "g-50003" }], toiDa: 15 }).join("\n");
    assert.match(s, /TẠM TÍNH/);
    assert.match(s, /Page giả: 3 khách mới, chốt 1 \(33,3%\)/);
    assert.match(s, /Nhân viên A: 2 cuộc/);
    assert.match(s, /Chấm AI: 2\/3 cuộc có tin khách, model model-a, lần chấm cuối 21:40 10\/01/);
    assert.match(s, /\[nóng 8\] Page giả · MA001 · đã cho size, hỏi giá · https:\/\/pancake\.vn\/900000000000001\?c_id=g-50001/);
    assert.doesNotMatch(s, /c_id=g-50002/, "cuộc đã có đơn không còn là khách cần chăm");
    assert.match(s, /Chưa chấm: 1 cuộc/);
    assert.ok(s.includes(linkPancake(PAGE, "g-50003")));
  });
  it("chưa có bản tính ngày đó thì nói rõ, không bịa số", () => {
    assert.deepEqual(dongCskh({ ngay: NGAY, k: null, g: null, chamLuc: null, tenPage: {}, chuaCham: [], toiDa: 15, loi: "chưa đồng bộ" }), ["## CSKH 10/01: chưa có (chưa đồng bộ)"]);
  });
  it("chưa chấm AI thì vẫn có số đếm, ghi chấm 'chưa có'", () => {
    const s = dongCskh({ ngay: NGAY, k, g: null, chamLuc: null, tenPage: {}, chuaCham: [], toiDa: 15 }).join("\n");
    assert.match(s, /Chấm AI: chưa có/);
    assert.match(s, /900000000000001: 3 khách mới/);
  });
});
