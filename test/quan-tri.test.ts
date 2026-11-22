/** Web quản trị, trang "Hôm nay": hệ số chi thật, phần trăm so trần, thiếu dữ liệu thì không ra số 0. Supabase giả ở tầng fetch. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HE_SO_QC, KENH, TRAN_QC_THANG, amTon, chiThat, demDaDong, gioVN, gomViec, oBan, phanTram, soTran, thayDoi, tien, tonSapHet, tongBan, tyLe,
  type DongBan, type NguCanhBan,
} from "../src/lib/quan-tri/tinh";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

describe("chi quảng cáo thật", () => {
  it("nhân đúng hệ số từng nền tảng", () => {
    assert.deepEqual(HE_SO_QC, { shopee: 1.08, facebook: 1.111, tiktok: 1.1 });
    assert.equal(chiThat(1_000_000, "shopee"), 1_080_000);
    assert.equal(chiThat(1_000_000, "facebook"), 1_111_000);
    assert.equal(chiThat(1_000_000, "tiktok"), 1_100_000);
    assert.equal(chiThat(2_268_416, "facebook"), 2_520_210);
    assert.equal(chiThat(0, "shopee"), 0);
  });
  it("không có số thì null, không phải 0", () => {
    for (const x of [null, undefined, NaN]) assert.equal(chiThat(x as any, "facebook"), null);
  });
});

describe("chi tháng so với trần 200 triệu", () => {
  it("tính phần trăm và phần còn lại; nêu tên kênh thiếu thay vì cộng 0", () => {
    assert.equal(TRAN_QC_THANG, 200_000_000);
    const t = soTran([
      { nenTang: "shopee", chi: chiThat(100_000_000, "shopee") },
      { nenTang: "facebook", chi: chiThat(20_000_000, "facebook"), thieu: "chỉ có số từ 12/11" },
      { nenTang: "tiktok", chi: null },
    ]);
    assert.equal(t.tong, 108_000_000 + 22_220_000);
    assert.equal(t.pct, 130_220_000 / 200_000_000);
    assert.equal(t.conLai, 69_780_000);
    assert.equal(t.vuot, false);
    assert.deepEqual(t.thieu, ["Facebook: chỉ có số từ 12/11", "TikTok: chưa có nguồn"]);
  });
  it("vượt trần", () => {
    const t = soTran([{ nenTang: "shopee", chi: 210_000_000 }]);
    assert.equal(t.vuot, true);
    assert.equal(t.conLai, -10_000_000);
    assert.equal(phanTram(t.pct), "105%");
  });
  it("không kênh nào có số: tổng là null", () => {
    const t = soTran([{ nenTang: "shopee", chi: null, thieu: "lỗi đọc số" }, { nenTang: "tiktok", chi: null }]);
    assert.deepEqual([t.tong, t.pct, t.conLai, t.vuot], [null, null, null, false]);
    assert.equal(t.thieu.length, 2);
  });
});

describe("tỉ lệ", () => {
  it("thiếu một vế hoặc mẫu số 0 thì null", () => {
    assert.equal(tyLe(10, 40), 0.25);
    assert.equal(tyLe(10, 0), null);
    assert.equal(tyLe(null, 40), null);
    assert.equal(tyLe(10, null), null);
    assert.ok(Math.abs((thayDoi(112, 100) as number) - 0.12) < 1e-9);
    assert.equal(thayDoi(112, null), null);
  });
});

const ROWS: DongBan[] = [
  { ky: "2026-11-20", kenh: "shopee_magickids", don_chot: 138, doanh_so_giu: 40_000_000, don_tien_ve_uoc_tinh: 138, lai_truoc_qc: 12_000_000, lai_sau_qc: 7_000_000 },
  { ky: "2026-11-19", kenh: "facebook", don_chot: 39, doanh_so_giu: 14_000_000, lai_truoc_qc: 7_000_000, lai_sau_qc: null },
  { ky: "2026-11-19", kenh: "tiktok", don_chot: 6, doanh_so_giu: 1_700_000, lai_truoc_qc: null, lai_sau_qc: null },
];
const CTX: NguCanhBan = { pancakeDen: "2026-11-19", shopeeDen: "2026-11-21", fbChi: new Map([["2026-11-19", 2_000_000]]) };
const kenh = (code: string) => KENH.find((k) => k.code === code)!;

describe("doanh số, lãi theo kênh", () => {
  it("Shopee: lãi sau quảng cáo lấy từ database, ghi chú đơn chưa quyết toán", () => {
    const o = oBan(ROWS, kenh("shopee_magickids"), "2026-11-20", CTX);
    assert.deepEqual([o.don, o.doanhSo, o.lai, o.thieu], [138, 40_000_000, 7_000_000, null]);
    assert.match(o.laiGhiChu!, /138 đơn chưa quyết toán/);
  });
  it("Shopee không có dòng nhưng đã thu tới ngày đó: 0 thật", () => {
    const o = oBan(ROWS, kenh("shopee_annie"), "2026-11-20", CTX);
    assert.deepEqual([o.don, o.doanhSo, o.lai, o.thieu], [0, 0, 0, null]);
  });
  it("Facebook: lãi = lãi trước quảng cáo − chi Meta × 1,111", () => {
    const o = oBan(ROWS, kenh("facebook"), "2026-11-19", CTX);
    assert.equal(o.lai, 7_000_000 - 2_222_000);
    assert.equal(o.laiGhiChu, "chưa trừ phí ship");
  });
  it("Facebook chưa đồng bộ tới ngày đó: null kèm lý do, không phải 0", () => {
    const o = oBan(ROWS, kenh("facebook"), "2026-11-20", CTX);
    assert.deepEqual([o.don, o.doanhSo, o.lai], [null, null, null]);
    assert.match(o.thieu!, /mới đồng bộ đến 19\/11/);
    const khongBiet = oBan(ROWS, kenh("facebook"), "2026-11-20", { ...CTX, pancakeDen: null });
    assert.equal(khongBiet.doanhSo, null);
  });
  it("Facebook có đơn nhưng chưa có chi quảng cáo ngày đó: lãi null", () => {
    const o = oBan(ROWS, kenh("facebook"), "2026-11-19", { ...CTX, fbChi: new Map() });
    assert.equal(o.doanhSo, 14_000_000);
    assert.equal(o.lai, null);
    assert.match(o.laiGhiChu!, /chưa có chi quảng cáo Facebook/);
  });
  it("TikTok: có doanh số, lãi null vì chưa có phí sàn", () => {
    const o = oBan(ROWS, kenh("tiktok"), "2026-11-19", CTX);
    assert.deepEqual([o.doanhSo, o.lai, o.laiGhiChu], [1_700_000, null, "chưa có phí sàn TikTok"]);
  });
  it("tổng chỉ cộng kênh có số và nêu tên kênh thiếu", () => {
    const t = tongBan(KENH.map((k) => ({ kenh: k, o: oBan(ROWS, k, "2026-11-20", CTX) })));
    assert.equal(t.doanhSo, 40_000_000);
    assert.equal(t.don, 138);
    assert.equal(t.lai, 7_000_000);
    assert.deepEqual(t.thieuKenh, ["Facebook", "TikTok"]);
    const rong = tongBan(KENH.slice(2).map((k) => ({ kenh: k, o: oBan(ROWS, k, "2026-11-20", CTX) })));
    assert.deepEqual([rong.doanhSo, rong.don, rong.lai], [null, null, null]);
  });
});

describe("tồn kho, việc, đóng hàng", () => {
  it("mã còn dưới 7 ngày bán: bỏ mã hết hàng và mã không bán", () => {
    const r = tonSapHet([
      { code: "AO1", ton: 30, ban_moi_ngay: 10 },
      { code: "AO2", ton: 70, ban_moi_ngay: 10 },
      { code: "AO3", ton: 0, ban_moi_ngay: 5 },
      { code: "AO4", ton: 50, ban_moi_ngay: 0 },
      { code: "AO5", ton: "6", ban_moi_ngay: "6" },
    ]);
    assert.deepEqual(r.map((x) => [x.code, x.conNgay]), [["AO5", 1], ["AO1", 3]]);
  });
  it("âm tồn gom theo mã", () => {
    const r = amTon([
      { sku: "QD26001DEN150", product_code: "QD26001", stock: -3 },
      { sku: "QD26001DEN160", product_code: null, stock: -2 },
      { sku: "AO26012DO180", product_code: "AO26012", stock: -1 },
      { sku: "AO26012DO170", product_code: "AO26012", stock: 4 },
    ]);
    assert.deepEqual(r, [{ code: "QD26001", bienThe: 2, tongAm: -5 }, { code: "AO26012", bienThe: 1, tongAm: -1 }]);
  });
  it("việc theo người: trễ khi hạn trước hôm nay", () => {
    const r = gomViec(
      [
        { assignee: "Vân", due: "2026-11-20", priority: 1 },
        { assignee: "Vân", due: "2026-11-21", priority: 2 },
        { assignee: "Vân", due: null, priority: 2 },
        { assignee: "Hiền", due: "2026-11-25", priority: 1 },
      ],
      "2026-11-21"
    );
    assert.deepEqual(r, [{ nguoi: "Vân", mo: 3, tre: 1, gap: 1 }, { nguoi: "Hiền", mo: 1, tre: 0, gap: 1 }]);
  });
  it("đơn đã đóng: khớp mã vận đơn, mã đơn hoặc số đơn; đếm đơn ngoài danh sách", () => {
    const r = demDaDong(["PKE1", "2611A", "500742", "PKE9"], [
      { ma: "pke1" }, { ma: "SPX1", ma_don: "2611A" }, { ma: "X", so_don: "500742" }, { ma: "PKE1" }, { ma: "LA1" }, { ma: "LA1" },
    ]);
    assert.deepEqual(r, { tong: 4, daDong: 3, ngoaiDanhSach: 1 });
  });
});

describe("hiển thị", () => {
  it("giờ Việt Nam HH:MM dd/mm", () => {
    assert.equal(gioVN("2026-11-21T16:45:00Z"), "23:45 21/11");
    assert.equal(gioVN("2026-11-21T18:10:00Z"), "01:10 22/11");
    assert.equal(gioVN(null), null);
    assert.equal(gioVN("x"), null);
  });
  it("tiền gọn; thiếu thì ghi chưa có", () => {
    assert.equal(tien(36_349_061), "36,3tr");
    assert.equal(tien(200_000_000), "200tr");
    assert.equal(tien(1_250_000_000), "1,25 tỷ");
    assert.equal(tien(850_400), "850k");
    assert.equal(tien(-2_500_000), "−2,5tr");
    assert.equal(tien(0), "0");
    assert.equal(tien(null), "chưa có");
    assert.equal(phanTram(null), "chưa có");
    assert.equal(phanTram(0.123, true), "+12%");
  });
});

// ---------------------------------------------------------------------------
// Đọc Supabase (giả ở tầng fetch)
// ---------------------------------------------------------------------------

type Fake = { rpc: Record<string, unknown>; table: (name: string, q: URLSearchParams) => unknown; count?: number };
let fake: Fake;
const calls: { method: string; path: string }[] = [];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const pgErr = (code: string, message: string, status = 404) => json({ code, message, details: null, hint: null }, status);
class Loi { constructor(public code: string, public message: string) {} }

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const path = url.pathname.replace("/rest/v1/", "");
  calls.push({ method, path });
  if (path.startsWith("rpc/")) {
    const fn = path.slice(4);
    const v = fake.rpc[fn];
    if (v === undefined) return pgErr("PGRST202", `Could not find the function public.${fn} in the schema cache`);
    return json(v);
  }
  if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${fake.count ?? 0}` } });
  const v = fake.table(path, url.searchParams);
  if (v instanceof Loi) return pgErr(v.code, v.message, 500);
  return json(v ?? []);
}) as typeof fetch;

const NOW = new Date("2026-11-21T10:00:00+07:00");

function bang(name: string, q: URLSearchParams): unknown {
  if (name === "ads_shop_hourly")
    return [
      { date: "2026-11-01", expense: 50_000_000, updated_at: "2026-11-02T00:00:00Z" },
      { date: "2026-11-20", expense: 4_000_000, updated_at: "2026-11-20T17:00:00Z" },
      { date: "2026-11-21", expense: 1_000_000, updated_at: "2026-11-21T02:45:00Z" },
    ];
  if (name === "fb_ad_daily")
    return q.get("select") === "ngay"
      ? [{ ngay: "2026-11-12" }]
      : [
          { ngay: "2026-11-12", spend: 10_000_000, updated_at: "2026-11-13T00:00:00Z" },
          { ngay: "2026-11-20", spend: 2_000_000, updated_at: "2026-11-21T00:00:00Z" },
        ];
  if (name === "pancake_variations")
    return q.get("select") === "updated_at" ? [{ updated_at: "2026-11-20T18:15:00Z" }] : [{ sku: "QD26001DEN150", product_code: "QD26001", stock: -3 }];
  if (name === "kho_don") return [{ ma: "PKE1", tao_luc: "2026-11-21T01:00:00Z" }, { ma: "PKE2", tao_luc: "2026-11-21T01:00:00Z" }];
  if (name === "kho_video") return [{ ma: "PKE1", ma_don: null, so_don: null, bat_dau: "2026-11-21T02:30:00Z" }];
  if (name === "job_runs")
    return q.get("ok") === "eq.false" ? [] : [{ started_at: "2026-11-21T02:45:00Z", finished_at: "2026-11-21T02:46:00Z", ok: true }];
  return [];
}

const SALES = {
  dong: [
    { ky: "2026-11-20", kenh: "shopee_magickids", don_chot: 100, doanh_so_giu: 40_000_000, don_tien_ve_uoc_tinh: 100, lai_truoc_qc: 12_000_000, lai_sau_qc: 7_680_000 },
    { ky: "2026-11-13", kenh: "shopee_magickids", don_chot: 80, doanh_so_giu: 32_000_000, don_tien_ve_uoc_tinh: 0, lai_truoc_qc: 9_000_000, lai_sau_qc: 6_000_000 },
    { ky: "2026-11-21", kenh: "shopee_magickids", don_chot: 20, doanh_so_giu: 8_000_000, don_tien_ve_uoc_tinh: 20, lai_truoc_qc: 2_000_000, lai_sau_qc: 920_000 },
    { ky: "2026-11-13", kenh: "facebook", don_chot: 30, doanh_so_giu: 10_000_000, lai_truoc_qc: 5_000_000, lai_sau_qc: null },
  ],
};
const WEB = {
  viec: [{ nguoi: "Vân", mo: 119, tre: 112, gap: 38 }, { nguoi: "Anh Tùng", mo: 2, tre: 0, gap: 0 }],
  de_xuat: [{ phong: "Kiều Trang", viec: "meta.change_budget", so: 2, cu_nhat: "2026-11-20T03:00:00Z" }],
  dong_bo: [{ job: "pancake_orders", lan_cuoi: "2026-11-21T00:31:00Z", lan_cuoi_ok: "2026-11-20T00:01:00Z", ok: false }],
  don_pancake: {
    den: "2026-11-19T12:23:00Z",
    dong_bo_luc: "2026-11-21T00:31:00Z",
    mo: [
      { kenh: "facebook", trang_thai: "waitting", so: 244, cu_nhat: "2026-10-23" },
      { kenh: "shopee_magickids", trang_thai: "waitting", so: 86, cu_nhat: "2026-11-08" },
      { kenh: "facebook", trang_thai: "new", so: 18, cu_nhat: "2026-11-18" },
    ],
  },
};

describe("trang Hôm nay đọc Supabase", async () => {
  const { taiHomNay } = await import("../src/lib/quan-tri/hom-nay");

  it("đủ nguồn: ghép đúng số, kênh chưa đồng bộ không ra 0", async () => {
    fake = { rpc: { mk_web_hom_nay: WEB, mk_sales: SALES, mk_products: [{ code: "AO1", name: "Áo", ton: 30, ban_moi_ngay: 10 }] }, table: bang, count: 313 };
    calls.length = 0;
    const d = await taiHomNay(NOW);
    assert.deepEqual([d.homNay, d.homQua, d.luc, d.thieuHam], ["2026-11-21", "2026-11-20", "10:00 21/11", false]);

    // Doanh số: hôm qua Shopee có số; Facebook, TikTok chưa đồng bộ tới 20/11 nên null
    const [qua, nay] = d.ban.cot;
    const sp = qua.dong.find((x) => x.kenh.code === "shopee_magickids")!;
    assert.equal(sp.o.doanhSo, 40_000_000);
    assert.ok(Math.abs(sp.thayDoi! - 0.25) < 1e-9);
    const fb = qua.dong.find((x) => x.kenh.code === "facebook")!;
    assert.equal(fb.o.doanhSo, null);
    assert.equal(fb.truoc.doanhSo, 10_000_000);
    assert.deepEqual(qua.tong.thieuKenh, ["Facebook", "TikTok"]);
    assert.equal(qua.tong.doanhSo, 40_000_000);
    assert.equal(qua.thayDoi, null, "hai ngày cộng khác bộ kênh thì không so tổng");
    assert.equal(nay.tong.doanhSo, 8_000_000);
    assert.equal(d.ban.soLucShopee, "09:46 21/11");
    assert.equal(d.ban.soLucPancake, "19:23 19/11");
    assert.equal(d.ban.pancakeLoi, true);

    // Quảng cáo: hệ số, tỉ lệ chi/doanh số, tháng so trần
    const qcQua = d.qc.ngay[0].dong;
    assert.deepEqual(qcQua.map((x) => x.chi), [4_320_000, 2_222_000, null]);
    assert.ok(Math.abs(qcQua[0].tyLe! - 4_320_000 / 40_000_000) < 1e-9);
    assert.equal(qcQua[1].tyLe, null, "Facebook chưa có doanh số ngày đó thì không ra tỉ lệ");
    assert.equal(d.qc.ngay[1].dong[1].chi, null, "Facebook chưa có chi hôm nay");
    assert.equal(d.qc.thang.tong, 59_400_000 + 13_332_000);
    assert.ok(Math.abs(d.qc.thang.pct! - 72_732_000 / 200_000_000) < 1e-9);
    assert.deepEqual(d.qc.thang.thieu, ["Facebook: chỉ có số từ 12/11, thiếu các ngày trước đó", "TikTok: chưa có nguồn chi quảng cáo TikTok"]);

    // Tồn, đơn, việc, hệ thống
    assert.deepEqual(d.ton.sapHet!.map((x) => x.code), ["AO1"]);
    assert.deepEqual(d.ton.am, [{ code: "QD26001", bienThe: 1, tongAm: -3 }]);
    assert.deepEqual(d.don.dongHang, { tong: 2, daDong: 1, ngoaiDanhSach: 0 });
    assert.equal(d.don.shopeeChoGui, 313);
    assert.deepEqual(d.don.pancakeMo, [{ nhan: "Chờ hàng", so: 330, cuNhat: "2026-10-23" }, { nhan: "Đơn mới", so: 18, cuNhat: "2026-11-18" }]);
    assert.deepEqual(d.viec.nguoi![0], { nguoi: "Vân", mo: 119, tre: 112, gap: 38 });
    assert.equal(d.viec.deXuatSo, 2);
    assert.equal(d.viec.itNhat, false);
    const pancake = d.heThong.nguon.find((x) => x.ten.startsWith("Đơn Pancake"))!;
    assert.equal(pancake.tinhTrang, "loi");
    assert.equal(d.heThong.nguon.find((x) => x.ten.startsWith("Đơn và quảng cáo Shopee"))!.tinhTrang, "tot");
    assert.equal(d.heThong.nguon.find((x) => x.ten.startsWith("Đơn Viettel Post"))!.tinhTrang, "chua_co");

    // Chỉ đọc: không có lệnh ghi nào ngoài gọi hàm đọc
    assert.deepEqual(calls.filter((c) => !["GET", "HEAD"].includes(c.method)).map((c) => c.path).sort(), ["rpc/mk_products", "rpc/mk_sales", "rpc/mk_web_hom_nay"]);
  });

  it("chưa chạy migration và bảng quảng cáo lỗi: báo thiếu, đếm tạm việc, không số nào thành 0", async () => {
    const tasks = Array.from({ length: 200 }, (_, i) => ({ assignee: i % 2 ? "Vân" : "Hiền", due: "2026-11-01", priority: 2 }));
    fake = {
      rpc: { mk_sales: SALES, mk_task_list: tasks, mk_list_proposals: [{}, {}, {}] },
      table: (name, q) => (name === "ads_shop_hourly" || name === "fb_ad_daily" || name === "kho_don" ? new Loi("42P01", `relation "${name}" does not exist`) : bang(name, q)),
      count: 5,
    };
    const d = await taiHomNay(NOW);
    assert.equal(d.thieuHam, true);
    assert.equal(d.ban.soLucPancake, null);
    assert.equal(d.ban.cot[0].dong.find((x) => x.kenh.code === "facebook")!.o.doanhSo, null);
    assert.deepEqual(d.qc.ngay[0].dong.map((x) => x.chi), [null, null, null]);
    assert.deepEqual([d.qc.thang.tong, d.qc.thang.pct], [null, null]);
    assert.equal(d.qc.thang.thieu.length, 3);
    assert.ok(d.qc.loi);
    assert.equal(d.ton.sapHet, null, "mk_products lỗi thì khối tồn ghi chưa có");
    assert.equal(d.don.dongHang, null);
    assert.ok(d.don.dongHangLoi);
    assert.equal(d.don.pancakeMo, null);
    assert.equal(d.viec.itNhat, true);
    assert.deepEqual(d.viec.nguoi, [{ nguoi: "Hiền", mo: 100, tre: 100, gap: 0 }, { nguoi: "Vân", mo: 100, tre: 100, gap: 0 }]);
    assert.equal(d.viec.deXuatSo, 3);
    assert.equal(d.heThong.nguon.find((x) => x.ten.startsWith("Đơn Pancake"))!.tinhTrang, "chua_co");
    assert.equal(d.heThong.nguon.find((x) => x.ten === "Quảng cáo Facebook")!.tinhTrang, "chua_co");
  });
});
