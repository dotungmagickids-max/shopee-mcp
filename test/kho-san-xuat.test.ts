/** Sổ hàng xưởng trong app quầy kho: chỉ đọc, bỏ giá ngay ở máy chủ. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boTien, soChoKho } from "../src/lib/kho-san-xuat";
import type { SoSanXuat } from "../src/lib/san-xuat-data";

describe("boTien", () => {
  it("bỏ vế có giá, giữ vế còn lại", () => {
    assert.equal(boTien("PĐH-THỬ-03 · 730. Giá 66.000 (130–150), 69.000 (160–180)"), "PĐH-THỬ-03 · 730.");
    assert.equal(boTien("Phiếu xưởng 21/11 Lần 2. Pancake #1003 (47 × 91.000). Lô 1 còn 301 (Đỏ 105, Trắng 58)"), "Phiếu xưởng 21/11 Lần 2. · Pancake #1003. · Lô 1 còn 301 (Đỏ 105, Trắng 58)");
    assert.equal(boTien("Kho A nhận đủ. Nhập Pancake #1002 giá tạm 125.000 (anh duyệt 21/11). Còn XT 65"), "Kho A nhận đủ. · Còn XT 65");
    assert.equal(boTien("Giá lô 2 chưa chốt"), "");
    assert.equal(boTien("Đã trả 61000 cho xưởng; còn 12 cái"), "còn 12 cái");
    assert.equal(boTien("Tạm tính 91k một cái · chờ kho"), "chờ kho");
  });
  it("không coi số lượng, ngày, mã phiếu là tiền", () => {
    for (const s of ["Đơn 2.400: lô 1 1.000. Chờ ngày trả", "PĐH-261117-05-v2 · lô 2 370 chưa cắt", "Theo phiếu nhập Pancake #24654 (nhập 31/10)", "Tỉ lệ 130–180 = 1/2/2/1/2/1", "Sổ cắt B2 (cắt 18/11): Be 456"]) {
      assert.equal(boTien(s).replace(/ · /g, " "), s.replace(/ · /g, " "));
    }
    assert.equal(boTien(null), "");
  });
});

const so: SoSanXuat = {
  los: [
    {
      id: 1, ma_hang: "ADT26001", lo: "L1", phieu_dat_id: 10, ngay_cat: "2026-11-12", hen_tra: "2026-11-19", gia: 91000, trang_thai: "dang_ve",
      ghi_chu: "Đang in. Giá 91.000 đ/cái",
      dong: [{ mau: "Đỏ", size: "130", so_cat: 16 }, { mau: "Đỏ", size: "140", so_cat: 16 }, { mau: "Trắng", size: "130", so_cat: 8 }],
      doi_hen: [{ hen_cu: "2026-11-18", hen_moi: "2026-11-19", ly_do: "Xưởng B báo trễ, giảm 2.000 đ/cái" }],
    },
    { id: 2, ma_hang: "QD26002", lo: "L2", hen_tra: null, gia: 77000, trang_thai: "chua_doi_soat", dong: [{ mau: "Đen", size: "160", so_cat: 97 }] },
  ],
  hangVe: [
    { id: 1, lo_id: 1, ngay: "2026-11-21", nguoi_ky: "Kho A", so_phieu_pancake: "1003", ghi_chu: "Pancake #1003 (5 × 91.000)", dong: [{ mau: "Đỏ", size: "130", xuong_giao: 5, kho_dem: 5 }] },
    { id: 2, lo_id: 1, ngay: "2026-11-22", ghi_chu: "Chờ kho xác nhận", dong: [{ mau: "Trắng", size: "130", xuong_giao: 3, kho_dem: null }] },
    { id: 3, lo_id: 2, ngay: "2026-10-07", dong: [{ mau: "Đen", size: "160", xuong_giao: 66, kho_dem: null }] },
  ],
  phieu: [
    { id: 10, ma_hang: "ADT26001", dot: "L1", gia: 91000, trang_thai: "da_cat", dong: [{ mau: "Đỏ", size: "", so_luong: 40 }] },
    { id: 11, ma_hang: "ADT25003", dot: "", ngay_dat: "2026-11-17", gia: 66000, trang_thai: "cho_cat", ghi_chu: "PĐH-THỬ-03 · 730. Giá 66.000 (130–150), 69.000 (160–180)", dong: [{ mau: "Ghi", size: "", so_luong: 730 }] },
  ],
};

describe("soChoKho", () => {
  const r = soChoKho(so, "2026-11-22", 1);
  it("không trả giá ở bất kỳ đâu", () => {
    const txt = JSON.stringify(r);
    assert.ok(!/"gia"/.test(txt));
    for (const tien of ["91.000", "91000", "66.000", "66000", "69.000", "77000", "2.000 đ"]) assert.ok(!txt.includes(tien), tien);
    assert.equal(r.los[0].ghiChu, "Đang in.");
    assert.equal(r.los[0].doiHen[0].lyDo, "");
    assert.equal(r.phieu[0].ghiChu, "PĐH-THỬ-03 · 730.");
  });
  it("số tiến độ giống trang /san-xuat: còn nợ = cắt − kho đếm", () => {
    assert.deepEqual(r.tomTat, { loTre: 1, conNo: 35, veHomNay: 0, phieuHomNay: 0, choCat: 730, choKhoDem: 69 });
    const [a, b] = r.los;
    assert.deepEqual([a.ma, a.lo, a.soCat, a.khoDem, a.choKhoDem, a.conNo, a.ngayTre, a.choVe], ["ADT26001", "L1", 40, 5, 3, 35, 3, true]);
    assert.deepEqual(a.nhan, { k: "late", t: "Trễ 3 ngày" });
    assert.deepEqual(a.maTran?.sizes, ["130", "140"]);
    assert.deepEqual(a.maTran?.hang.map((h) => [h.mau, h.o, h.tong]), [["Đỏ", [11, 16], 27], ["Trắng", [8, null], 8]]);
    assert.deepEqual(a.lanVe, [{ ngay: "2026-11-21", so: "5", pancake: "#1003" }, { ngay: "2026-11-22", so: "3 xưởng giao, chờ kho đếm", pancake: "" }]);
    assert.deepEqual([b.trangThai, b.choVe, b.maTran, b.theoMau, b.nhan.t], ["chua_doi_soat", false, null, [], "Chưa đối soát"]);
  });
  it("hàng về gom theo ngày, mới nhất trước; phiếu đặt chỉ còn phiếu chờ cắt", () => {
    assert.deepEqual(r.ngay.map((d) => [d.ngay, d.khoDem, d.choKhoDem]), [["2026-11-22", 0, 3], ["2026-11-21", 5, 0], ["2026-10-07", 0, 66]]);
    assert.deepEqual(r.ngay[1].lan[0], { lo: "ADT26001 L1", moTa: "Đỏ 130: 5", so: 5, choDem: false, ky: "Kho A", pancake: "Pancake #1003", ghiChu: "Pancake #1003" });
    assert.deepEqual(r.phieu.map((p) => [p.ma, p.conCho, p.soDat, p.daCat]), [["ADT25003", 730, 730, 0]]);
  });
});

describe("GET /api/kho/don?sanxuat=1", () => {
  it("cùng cổng mã truy cập với các lời gọi khác của app kho", async () => {
    const { GET } = await import("../src/app/api/kho/don/route");
    const cu = process.env.KHO_API_KEY;
    process.env.KHO_API_KEY = "khoa-thu";
    try {
      const u = "https://x.test/api/kho/don?sanxuat=1";
      assert.equal((await GET(new Request(u))).status, 401);
      assert.equal((await GET(new Request(u, { headers: { "x-mk-key": "sai" } }))).status, 401);
    } finally {
      if (cu == null) delete process.env.KHO_API_KEY;
      else process.env.KHO_API_KEY = cu;
    }
  });
});
