/** Trang cho xưởng (/xuong): bản đọc không có giá, kiểm tra lệnh ghi, cổng mã truy cập riêng. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SoSanXuat } from "../src/lib/san-xuat-data";
import { CHUA_BAT_THONG_TIN, checkXuongKey, docLenhGhi, loiGhi, ngayHopLe, soChoXuong } from "../src/lib/xuong";

const so: SoSanXuat = {
  los: [
    {
      id: 1, ma_hang: "MA26001", lo: "L1", phieu_dat_id: 10, ngay_cat: "2026-11-12", hen_tra: "2026-11-19", gia: 91000, trang_thai: "dang_ve",
      ngay_chot: "2026-11-03", xuong: "Xưởng B", ngay_vai_ve: "2026-11-06", thong_tin_sx: "Đang in. Công in 3.000 đ/cái",
      ghi_chu: "Ghi chú nội bộ của công ty. Giá 91.000 đ/cái",
      dong: [{ mau: "Đỏ", size: "130", so_cat: 16 }, { mau: "Đỏ", size: "140", so_cat: 16 }, { mau: "Trắng", size: "130", so_cat: 8 }],
      doi_hen: [{ hen_cu: "2026-11-18", hen_moi: "2026-11-19", ly_do: "Người A báo máy in hỏng" }],
    },
    { id: 2, ma_hang: "MA26002", lo: "L2", hen_tra: null, gia: 77000, trang_thai: "chua_doi_soat", ngay_chot: null, dong: [{ mau: "Đen", size: "160", so_cat: 97 }] },
    { id: 3, ma_hang: "MA26004", lo: "L1", phieu_dat_id: 12, hen_tra: "2026-11-10", gia: 55000, trang_thai: "dang_ve", ngay_chot: null, dong: [{ mau: "Be", size: "150", so_cat: 20 }] },
  ],
  hangVe: [
    { id: 1, lo_id: 1, ngay: "2026-11-21", nguoi_ky: "Kho A", so_phieu_pancake: "1003", ghi_chu: "Pancake #1003 (5 × 91.000)", dong: [{ mau: "Đỏ", size: "130", xuong_giao: 5, kho_dem: 5 }] },
    { id: 2, lo_id: 1, ngay: "2026-11-22", ghi_chu: "Chờ kho xác nhận", dong: [{ mau: "Trắng", size: "130", xuong_giao: 3, kho_dem: null }] },
    { id: 3, lo_id: 2, ngay: "2026-10-07", dong: [{ mau: "Đen", size: "160", xuong_giao: 66, kho_dem: null }] },
    { id: 4, lo_id: 3, ngay: "2026-11-09", so_phieu_pancake: "1004", dong: [{ mau: "Be", size: "150", xuong_giao: null, kho_dem: 20 }] },
  ],
  phieu: [
    { id: 10, ma_hang: "MA26001", dot: "L1", ngay_dat: "2026-11-01", gia: 91000, trang_thai: "cho_cat", ghi_chu: "Giá 91.000", dong: [{ mau: "Đỏ", size: "130", so_luong: 30 }, { mau: "Đỏ", size: "140", so_luong: 20 }, { mau: "Trắng", size: "130", so_luong: 10 }] },
    { id: 11, ma_hang: "MA26003", dot: "", ngay_dat: "2026-11-17", gia: 66000, trang_thai: "cho_cat", ghi_chu: "PĐH-THỬ-03. Giá 66.000", dong: [{ mau: "Ghi", size: "", so_luong: 730 }] },
    { id: 12, ma_hang: "MA26004", dot: "T10", ngay_dat: "2026-10-20", gia: 55000, trang_thai: "da_cat", dong: [{ mau: "Be", size: "150", so_luong: 20 }] },
    { id: 13, ma_hang: "MA26005", dot: "", gia: 44000, trang_thai: "huy", dong: [{ mau: "Đen", size: "", so_luong: 100 }] },
  ],
};

describe("soChoXuong", () => {
  const r = soChoXuong(so, "2026-11-22", 1);
  const txt = JSON.stringify(r);

  it("không có giá, tiền, ghi chú nội bộ, số phiếu Pancake", () => {
    assert.ok(!/"gia"|"ghiChu"|"ghi_chu"|"pancake"/i.test(txt));
    for (const x of ["91.000", "91000", "66.000", "66000", "77000", "55000", "44000", "3.000", "nội bộ", "1003", "1004", "Kho A"]) assert.ok(!txt.includes(x), x);
    assert.equal(r.los.find((l) => l.id === 1)?.sx.thongTin, "Đang in.");
  });

  it("đơn đã nhận: mọi phiếu chưa hủy và lô không có phiếu, kèm trạng thái và số còn nợ", () => {
    assert.deepEqual(
      r.don.map((d) => [d.ma, d.soPhieu, d.trangThai, d.tongDat, d.daCat, d.daGiao, d.khoDem, d.choCat, d.conNo]),
      [
        ["MA26001", "L1", "dang_tra", 60, 40, 8, 5, 20, 35],
        ["MA26002", "L2", "dang_tra", null, 97, 66, 0, 0, 0],
        ["MA26003", "", "cho_cat", 730, 0, 0, 0, 730, 0],
        ["MA26004", "T10", "xong", 20, 20, 20, 20, 0, 0],
      ]
    );
    const [d1, khongPhieu, d3] = r.don;
    assert.deepEqual([khongPhieu.id, khongPhieu.chuaDoiSoat], [null, true]);
    assert.equal(d1.nhan, "Đang trả · cắt một phần");
    assert.deepEqual(d1.los, ["L1"]);
    assert.deepEqual(d1.maTran?.sizes, ["130", "140"]);
    assert.deepEqual(d1.maTran?.hang.map((h) => [h.mau, h.o, h.tong]), [["Đỏ", [30, 20], 50], ["Trắng", [10, null], 10]]);
    assert.deepEqual([d3.maTran, d3.theoMau], [null, [{ mau: "Ghi", so: 730 }]]);
  });

  it("tiến độ theo lô: cắt, đã trả, còn nợ, trễ, từng đợt trả", () => {
    const a = r.los.find((l) => l.id === 1)!;
    assert.deepEqual([a.ma, a.lo, a.phieuId, a.soCat, a.daGiao, a.khoDem, a.conNo, a.ngayTre, a.henTra], ["MA26001", "L1", 10, 40, 8, 5, 35, 3, "2026-11-19"]);
    assert.deepEqual(a.lanVe, [
      { ngay: "2026-11-21", giao: 5, khoDem: 5, choDem: false },
      { ngay: "2026-11-22", giao: 3, khoDem: 0, choDem: true },
    ]);
    assert.deepEqual(a.maTran?.hang.map((h) => [h.mau, h.o]), [["Đỏ", [11, 16]], ["Trắng", [8, null]]]);
    assert.deepEqual(a.doiHen, [{ cu: "2026-11-18", moi: "2026-11-19", lyDo: "Người A báo máy in hỏng" }]);
    assert.equal(r.los.find((l) => l.id === 2)?.phieuId, null);
    assert.deepEqual(r.tomTat, { loTre: 1, conNo: 35, veHomNay: 0, phieuHomNay: 0, choCat: 750, choKhoDem: 69, phieuChoCat: 2 });
  });

  it("báo database đã có phần ghi thông tin sản xuất (0026) hay chưa", () => {
    assert.equal(r.ghiThongTin, true);
    const cu: SoSanXuat = { ...so, los: so.los.map(({ ngay_chot: _a, xuong: _b, ngay_vai_ve: _c, thong_tin_sx: _d, ...l }) => l) };
    assert.equal(soChoXuong(cu, "2026-11-22", 1).ghiThongTin, false);
  });
});

describe("docLenhGhi", () => {
  const nay = "2026-11-23";
  const hen = { action: "hen", ma_hang: " ma26001 ", lo: " L1 ", ngay_hen: "2026-11-30", ly_do: "  Máy in hỏng,  chờ sửa ", nguoi: "  Người   A " };

  it("đổi ngày hẹn → đúng tham số của mk_sx_lot_reschedule", () => {
    assert.deepEqual(docLenhGhi(hen, nay), {
      ok: true,
      fn: "mk_sx_lot_reschedule",
      args: { p_agent: "Xưởng: Người A", p_ma_hang: "MA26001", p_lo: "L1", p_nguon: "Trang xưởng (/xuong): Người A", p_hen_moi: "2026-11-30", p_ly_do: "Máy in hỏng,  chờ sửa" },
    });
  });

  it("ghi thông tin sản xuất → đúng tham số của mk_sx_lot_info, trường trống là null", () => {
    assert.deepEqual(docLenhGhi({ action: "thongtin", ma_hang: "MA26001", lo: "L1", ngay_chot: "2026-11-03", xuong: "", ngay_vai_ve: null, thong_tin_sx: "Đang may\nxong 60%", nguoi: "Người B" }, nay), {
      ok: true,
      fn: "mk_sx_lot_info",
      args: { p_agent: "Xưởng: Người B", p_ma_hang: "MA26001", p_lo: "L1", p_nguon: "Trang xưởng (/xuong): Người B", p_ngay_chot: "2026-11-03", p_xuong: null, p_ngay_vai_ve: null, p_thong_tin_sx: "Đang may\nxong 60%" },
    });
  });

  const loi = (b: unknown) => {
    const r = docLenhGhi(b, nay);
    return r.ok ? null : r.error;
  };

  it("từ chối đầu vào sai", () => {
    for (const b of [null, "x", [], {}, { ...hen, action: "cat" }]) assert.ok(loi(b), JSON.stringify(b));
    assert.match(loi({ ...hen, nguoi: "A" })!, /tên người/);
    assert.match(loi({ ...hen, nguoi: "x".repeat(41) })!, /tên người/);
    assert.match(loi({ ...hen, nguoi: 123 })!, /tên người/);
    assert.match(loi({ ...hen, nguoi: "A\u0000B" })!, /tên người/);
    assert.match(loi({ ...hen, ma_hang: "M 1; drop" })!, /Mã hàng/);
    assert.match(loi({ ...hen, lo: "" })!, /lô/);
    assert.match(loi({ ...hen, lo: "x".repeat(31) })!, /lô/);
    for (const d of ["30/11/2026", "2026-02-30", "2026-13-01", 20261130, undefined]) assert.match(loi({ ...hen, ngay_hen: d })!, /YYYY-MM-DD/);
    assert.match(loi({ ...hen, ngay_hen: "2026-11-22" })!, /quá khứ/);
    assert.match(loi({ ...hen, ngay_hen: "2028-01-01" })!, /quá xa/);
    assert.match(loi({ ...hen, ly_do: " a " })!, /lý do/);
    assert.match(loi({ ...hen, ly_do: "x".repeat(301) })!, /lý do/);
    const tt = { action: "thongtin", ma_hang: "MA26001", lo: "L1", nguoi: "Người A" };
    assert.match(loi(tt)!, /Chưa có thông tin/);
    assert.match(loi({ ...tt, xuong: " ", thong_tin_sx: "" })!, /Chưa có thông tin/);
    assert.match(loi({ ...tt, ngay_chot: "2026-11-24" })!, /tương lai/);
    assert.match(loi({ ...tt, ngay_vai_ve: "03-11-2026" })!, /YYYY-MM-DD/);
    assert.match(loi({ ...tt, xuong: "x".repeat(101) })!, /dài quá/);
    assert.match(loi({ ...tt, thong_tin_sx: "x".repeat(501) })!, /dài quá/);
    assert.match(loi({ ...tt, thong_tin_sx: { a: 1 } })!, /không hợp lệ/);
  });

  it("hẹn đúng hôm nay thì được", () => {
    assert.equal(docLenhGhi({ ...hen, ngay_hen: nay }, nay).ok, true);
    assert.equal(ngayHopLe("2028-02-29"), true);
    assert.equal(ngayHopLe("2027-02-29"), false);
  });
});

describe("loiGhi", () => {
  it("database chưa có mk_sx_lot_info (chưa chạy 0026) → câu rõ ràng", () => {
    for (const e of [
      { code: "PGRST202", message: "Could not find the function public.mk_sx_lot_info(p_agent, p_lo) in the schema cache" },
      { code: "42703", message: 'column "ngay_chot" of relation "sx_lo_cat" does not exist' },
      { message: "function public.mk_sx_lot_info(text) does not exist" },
    ]) {
      assert.deepEqual(loiGhi("mk_sx_lot_info", e), { status: 501, error: CHUA_BAT_THONG_TIN, chuaBat: true });
    }
  });
  it("lỗi luật của database giữ câu tiếng Việt; lỗi khác không lộ chi tiết", () => {
    assert.deepEqual(loiGhi("mk_sx_lot_reschedule", { code: "P0001", message: "Ngày hẹn mới trùng ngày hẹn hiện tại (2026-11-30)" }), { status: 400, error: "Ngày hẹn mới trùng ngày hẹn hiện tại (2026-11-30)" });
    assert.deepEqual(loiGhi("mk_sx_lot_info", { code: "P0001", message: "Không có lô MA26001 L9. Tạo lô bằng mk_sx_lot_save trước" }), { status: 400, error: "Không có lô MA26001 L9" });
    const khac = loiGhi("mk_sx_lot_reschedule", { code: "08006", message: "connection to server at 10.0.0.1 failed" });
    assert.equal(khac.status, 502);
    assert.ok(!khac.error.includes("10.0.0.1"));
    assert.equal(loiGhi("mk_sx_lot_reschedule", { code: "PGRST202", message: "Could not find the function" }).status, 502);
  });
});

describe("/api/xuong", () => {
  const voiKhoa = async (xuong: string | undefined, kho: string | undefined, chay: () => Promise<void>) => {
    const cu = [process.env.XUONG_API_KEY, process.env.KHO_API_KEY];
    const dat = (k: string, v: string | undefined) => (v == null ? delete process.env[k] : (process.env[k] = v));
    dat("XUONG_API_KEY", xuong);
    dat("KHO_API_KEY", kho);
    try {
      await chay();
    } finally {
      dat("XUONG_API_KEY", cu[0]);
      dat("KHO_API_KEY", cu[1]);
    }
  };
  const u = "https://x.test/api/xuong";
  const goi = (key?: string) => new Request(u, key == null ? {} : { headers: { "x-mk-key": key } });

  it("mã truy cập riêng của xưởng: chưa đặt 503, sai 401, mã của kho không dùng được", async () => {
    const { GET, POST } = await import("../src/app/api/xuong/route");
    await voiKhoa(undefined, "khoa-kho", async () => {
      const r = await GET(goi("khoa-kho"));
      assert.equal(r.status, 503);
      assert.deepEqual(await r.json(), { error: "Chưa đặt XUONG_API_KEY" });
    });
    await voiKhoa("khoa-xuong", "khoa-kho", async () => {
      assert.equal(checkXuongKey(goi("khoa-xuong")), "ok");
      for (const k of [undefined, "sai", "khoa-kho", "khoa-xuongx"]) {
        const r = await GET(goi(k));
        assert.equal(r.status, 401);
        assert.equal(r.headers.get("cache-control"), "no-store");
      }
      assert.equal((await POST(new Request(u, { method: "POST", body: "{}" }))).status, 401);
    });
    await voiKhoa("chung-mot-ma", "chung-mot-ma", async () => {
      assert.equal((await GET(goi("chung-mot-ma"))).status, 503);
    });
  });

  it("POST sai đầu vào bị chặn trước khi tới database", async () => {
    const { POST } = await import("../src/app/api/xuong/route");
    await voiKhoa("khoa-xuong", undefined, async () => {
      const gui = (body: string) => POST(new Request(u, { method: "POST", headers: { "x-mk-key": "khoa-xuong" }, body }));
      assert.equal((await gui("không phải json")).status, 400);
      const r = await gui(JSON.stringify({ action: "hen", ma_hang: "MA26001", lo: "L1", ngay_hen: "hôm nay", ly_do: "Máy hỏng", nguoi: "Người A" }));
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /YYYY-MM-DD/);
    });
  });
});
