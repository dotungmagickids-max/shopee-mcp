/** Số trang kho rút gọn cho các phòng AI (công cụ mk_kho_*): đối chiếu đơn với sổ video đóng hàng. Dữ liệu giả. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GiaoRow, HoanRow, HuyRow, StockRow, XuatOrder } from "../src/lib/kho";
import { chiMucDaDong, endOfVnDay, giaoCoVanDe, huySauKhiDong, layLechGanDay, tomTatDongHang, tomTatHangHoan, tomTatKiemKe, tomTatTon, traMa, vnDay, vnTime } from "../src/lib/kho-doc";
import type { VideoRow } from "../src/lib/kho-store";
import { soNgayVideo } from "../src/lib/kho-tools";

// 2026-01-10 10:00 giờ VN
const NOW = Date.parse("2026-01-10T03:00:00Z");

function video(ma: string, batDau: string, x: Partial<VideoRow> = {}): VideoRow {
  return { file: `${ma}.mp4`, ma, ma_don: null, so_don: null, che_do: "DH", bat_dau: batDau, giay: 30, kich_thuoc: 1000, soat: "Đủ", kenh: "Shopee", loai_ma: null, may: "MAY1", da_xoa: false, cap_nhat: batDau, ...x };
}

function don(id: string, shipBy: number | null, x: Partial<XuatOrder> = {}): XuatOrder {
  return { id, channel: "Shopee", shop: "SHOP A", carrier: "SPX", group: "SPX", urgent: false, shipBy, created: NOW - 86400_000, eligible: true, reason: "", items: [], ...x };
}

describe("kho-doc", () => {
  it("giờ Việt Nam", () => {
    assert.equal(vnDay(Date.parse("2026-01-09T18:30:00Z")), "2026-01-10");
    assert.equal(vnTime(Date.parse("2026-01-09T18:30:00Z")), "2026-01-10 01:30");
    assert.equal(vnTime(null), null);
    assert.equal(endOfVnDay("2026-01-10"), Date.parse("2026-01-10T16:59:59.999Z"));
  });

  it("chỉ mục đã đóng: nhận mã quét, mã đơn, số đơn; bỏ video hàng hoàn và video đã xóa", () => {
    const idx = chiMucDaDong([
      video("SPXVN0001", "2026-01-10T01:00:00Z", { ma_don: "260110AAA", so_don: "5001" }),
      video("SPXVN0001", "2026-01-10T02:00:00Z", { may: "MAY2" }),
      video("HOAN01", "2026-01-10T01:00:00Z", { che_do: "HH" }),
      video("XOA01", "2026-01-10T01:00:00Z", { da_xoa: true }),
    ]);
    assert.equal(idx.get("SPXVN0001")?.may, "MAY2", "lấy lần quay gần nhất");
    assert.ok(idx.has("260110AAA"));
    assert.ok(idx.has("5001"));
    assert.equal(idx.has("HOAN01"), false);
    assert.equal(idx.has("XOA01"), false);
    const tra = traMa([" spxvn0001 ", "KHONGCO"], idx);
    assert.equal(tra[0].da_dong, true);
    assert.equal(tra[0].luc, "2026-01-10 09:00");
    assert.equal(tra[1].da_dong, false);
  });

  it("tóm tắt đóng hàng: Soát đơn, Shopee quá hạn / đến hạn chưa đóng, đơn chờ theo kênh", () => {
    const out = tomTatDongHang({
      ngay: "2026-01-10",
      now: NOW,
      video: [
        video("VD1", "2026-01-10T01:00:00Z"),
        video("VD2", "2026-01-10T01:30:00Z", { kenh: "Facebook" }),
        video("VDCU", "2026-01-08T01:30:00Z"),
        video("SP-DONG", "2026-01-10T00:30:00Z", { ma_don: "SPDONG" }),
      ],
      day: { ngay: "2026-01-10", codes: ["VD1", "VD2", "CHUA1"], notes: { CHUA1: { lyDo: "Thiếu hàng", xuLy: "Chờ xưởng" } }, resetAt: 0, updatedAt: 0 },
      orders: [
        don("SPQUAHAN", NOW - 3600_000),
        don("SPDONG", NOW - 3600_000),
        don("SPDENHAN", NOW + 3600_000, { arranged: true }),
        don("SPMAI", NOW + 2 * 86400_000),
        don("FB1", null, { channel: "Facebook" }),
      ],
      tra: ["VD1"],
    }) as any;
    assert.deepEqual(out.video_dong_hang_trong_ngay, { tong: 3, theo_kenh: { Shopee: 2, Facebook: 1 } });
    assert.equal(out.soat_don.tong_trong_danh_sach, 3);
    assert.equal(out.soat_don.da_dong, 2);
    assert.deepEqual(out.soat_don.danh_sach_chua_dong, [{ ma: "CHUA1", ly_do: "Thiếu hàng", xu_ly: "Chờ xưởng" }]);
    assert.equal(out.shopee_chua_dong.qua_han, 1);
    assert.equal(out.shopee_chua_dong.danh_sach_qua_han[0].ma_don, "SPQUAHAN");
    assert.equal(out.shopee_chua_dong.den_han_trong_ngay, 1);
    assert.equal(out.shopee_chua_dong.danh_sach_den_han[0].da_chuan_bi_hang, true);
    assert.deepEqual(out.don_cho_dong_hien_tai, { tong: 4, theo_kenh: { Shopee: 3, Facebook: 1 } });
    assert.equal(out.tra_ma[0].da_dong, true);
  });

  it("không có danh sách hay đơn chờ thì nói rõ, không coi là 0", () => {
    const out = tomTatDongHang({ ngay: "2026-01-10", now: NOW, video: [], day: null, orders: null, ordersErrors: ["Shopee: lỗi"] }) as any;
    assert.match(out.soat_don, /chưa có/);
    assert.match(out.shopee_chua_dong, /chưa đọc được/);
    assert.deepEqual(out.loi_doc_don, ["Shopee: lỗi"]);
  });

  it("đơn hủy sau khi đóng", () => {
    const idx = chiMucDaDong([video("VTP123", "2026-01-09T03:00:00Z")]);
    const rows: HuyRow[] = [
      { id: "500001", sys: "7001", kenh: "Pancake", codes: ["500001", "VTP123"], huyLuc: NOW - 3600_000, daLay: false },
      { id: "500002", sys: "7002", kenh: "Pancake", codes: ["500002"], huyLuc: NOW, daLay: false },
    ];
    const out = huySauKhiDong(rows, idx, { "500001": { state: "lay-lai" } });
    assert.equal(out.length, 1);
    assert.equal(out[0].ma_don, "500001");
    assert.equal(out[0].kho_ghi, "lay-lai");
  });

  it("giao có vấn đề và lấy lệch", () => {
    const g = (ma: string, con: boolean, kq?: "giao" | "hoan"): GiaoRow => ({ ma, id: "", channel: "Facebook", status: "Phát lỗi", reason: "Không liên lạc được", items: [], since: NOW, ngay: "2026-01-10", con, kq });
    const out = giaoCoVanDe([g("A", true), g("B", true), g("C", false, "giao"), g("D", false, "hoan")], { A: { state: "phat-lai" } }) as any;
    assert.equal(out.dang_mo, 2);
    assert.equal(out.chua_ghi_xu_ly, 1);
    assert.deepEqual(out.da_roi_danh_sach_30_ngay, { giao_duoc: 1, hoan: 1 });
    const lech = layLechGanDay(
      [
        { id: "l1", don: "D1", sku: "A1", code: "", thay: "A2", lyDo: "Hết", at: NOW - 3600_000, may: "M" },
        { id: "l2", don: "D2", sku: "B1", code: "", thay: "B2", lyDo: "", at: NOW - 10 * 86400_000, may: "M" },
      ],
      NOW
    );
    assert.equal(lech.length, 1);
    assert.equal(lech[0].thay_cho, "A2");
  });

  it("hàng hoàn gộp theo kênh, loại; đếm nhập hàng hoàn 7 ngày", () => {
    const r = (key: string, kind: HoanRow["kind"], qty: number): HoanRow => ({ key, channel: "Shopee", shop: "SHOP A", kind, id: key, codes: [], status: "", reason: "", refund: null, items: [{ sku: "X1", name: "", detail: "", quantity: qty }], since: NOW, due: null });
    const out = tomTatHangHoan(
      [r("k1", "tra-hang", 2), r("k2", "tra-hang", 1), r("k3", "giao-that-bai", 1)],
      { k1: { state: "du" } },
      [
        { id: "n1", sku: "X1", code: "", qty: 2, kind: "nhap", note: "", at: NOW, may: "" },
        { id: "n2", sku: "X1", code: "", qty: 1, kind: "bo", note: "", at: NOW, may: "" },
        { id: "n3", sku: "X1", code: "", qty: 5, kind: "nhap", note: "", at: NOW - 30 * 86400_000, may: "" },
      ],
      NOW
    ) as any;
    assert.equal(out.kien_dang_theo_doi, 3);
    assert.equal(out.kho_da_ghi_tinh_trang, 1);
    assert.deepEqual(out.theo_nhom["Shopee · khách trả hàng"], { kien: 2, cai: 3 });
    assert.deepEqual(out.nhap_hang_hoan_7_ngay, { luot: 2, cai_nhap: 2, luot_khong_nhap: 1 });
  });

  it("tồn gom theo mã hàng, không có tên; kiểm kê so với tồn", () => {
    const stock: StockRow[] = [
      ["ADT1DO140", 5, "TÊN KHÔNG ĐƯỢC LỘ", "ADT1", 1],
      ["ADT1DO150", 0, "TÊN KHÔNG ĐƯỢC LỘ", "ADT1", 2],
      ["QD9DE160", 3, "TÊN KHÔNG ĐƯỢC LỘ", "QD9", 0],
    ];
    const all = tomTatTon(stock) as any;
    assert.equal(all.tong_ton, 8);
    assert.equal(all.ma_hang, 2);
    assert.deepEqual(all.theo_ma.ADT1, { ton: 5, cho_hang: 3, phan_loai: 2, con_ton: 1 });
    assert.doesNotMatch(JSON.stringify(all), /TÊN/);
    const mot = tomTatTon(stock, ["adt1"]) as any;
    assert.equal(mot.theo_phan_loai.length, 2);
    assert.doesNotMatch(JSON.stringify(mot), /TÊN/);
    const kk = tomTatKiemKe(
      [
        { id: "1", sku: "ADT1DO140", code: "", qty: 4, ke: "", note: "", at: NOW, may: "" },
        { id: "2", sku: "QD9DE160", code: "", qty: 3, ke: "", note: "", at: NOW, may: "" },
      ],
      stock
    ) as any;
    assert.equal(kk.phan_loai_da_dem, 2);
    assert.deepEqual(kk.lech, [{ ma: "ADT1DO140", dem: 4, ton_pancake: 5, lech: -1 }]);
  });

  it("số ngày sổ video đọc đủ phủ ngày soát", () => {
    assert.equal(soNgayVideo("2026-01-10", NOW), 3);
    assert.equal(soNgayVideo("2026-01-01", NOW), 12);
    assert.equal(soNgayVideo("2025-01-01", NOW), 90);
  });
});

describe("noi-bo-tools", () => {
  it("hồ sơ mẫu cho phòng AI không có giá nhập, lọc theo trạng thái và mã", async () => {
    const { locHoSo } = await import("../src/lib/noi-bo-tools");
    const row = (id: number, ma: string, trang_thai: string) => ({ id, ma, ma_chinh_thuc: null, trang_thai, gia_nhap: "99.000", gia_ban: "199.000", cap_nhat_luc: "2026-01-10" }) as any;
    const ds = locHoSo([row(1, "M001", "co_media"), row(2, "M002", "cho_chup")], "co_media");
    assert.equal(ds.length, 1);
    assert.equal(ds[0].ma, "M001");
    assert.equal("gia_nhap" in ds[0], false);
    assert.equal(locHoSo([row(1, "M001", "co_media"), row(2, "M002", "cho_chup")], undefined, "m002").length, 1);
  });
});
