/** Sổ hàng xưởng: còn nợ, ngày trễ, lịch sử dời hẹn, kiểm tra đầu vào công cụ ghi, script nạp số đầu. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { z } from "zod";
import type { ApiKeyContext } from "../src/lib/api-keys";
import {
  conChoVe, conNoTheoMau, homNayVN, loiHangVe, maTran, moTaLanVe, nhanLo, nhanPancake, nhatKy, phieuChoCat, soNgay,
  tinhLo, tomTat, xepLo, type HangVe, type LoCat, type PhieuDat,
} from "../src/lib/san-xuat";
import { arrivalSaveInput, lotSaveInput, registerSanXuatTools, rescheduleInput } from "../src/lib/san-xuat-tools";
import { docCsv, duBao, lapKeHoach, ngayIso, so, soKyVong } from "../scripts/lib/sx-seed";

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

const HOM_NAY = "2026-11-21";

const lo = (over: Partial<LoCat> = {}): LoCat => ({
  id: 1, ma_hang: "ADT26001", lo: "L1", hen_tra: "2026-11-19", trang_thai: "dang_ve",
  dong: [
    { mau: "Đỏ", size: "130", so_cat: 16 },
    { mau: "Đỏ", size: "140", so_cat: 16 },
    { mau: "Trắng", size: "130", so_cat: 8 },
  ],
  ...over,
});
const ve = (id: number, ngay: string, dong: HangVe["dong"], over: Partial<HangVe> = {}): HangVe => ({ id, lo_id: 1, ngay, dong, ...over });

describe("còn nợ = số cắt − số kho đếm", () => {
  it("cộng mọi lần về theo màu × size; xưởng giao mà kho chưa đếm thì chưa tính", () => {
    const t = tinhLo(lo(), [
      ve(1, "2026-11-20", [{ mau: "Đỏ", size: "130", xuong_giao: 5, kho_dem: null }]),
      ve(2, "2026-11-21", [
        { mau: "Đỏ", size: "130", xuong_giao: 4, kho_dem: 4 },
        { mau: "đỏ", size: "140", xuong_giao: 10, kho_dem: 9 },
      ]),
      ve(3, "2026-11-21", [{ mau: "Đỏ", size: "130", xuong_giao: 1, kho_dem: 1 }], { lo_id: 99 }),
    ], HOM_NAY);
    assert.equal(t.soCat, 40);
    assert.equal(t.khoDem, 13);
    assert.equal(t.xuongGiao, 19);
    assert.equal(t.choKhoDem, 5);
    assert.equal(t.conNo, 27);
    const o = (m: string, s: string) => t.o.find((x) => x.mau === m && x.size === s)!;
    assert.equal(o("Đỏ", "130").conNo, 12);
    assert.equal(o("Đỏ", "140").conNo, 7, "màu khớp không phân biệt hoa thường; lấy kho đếm 9, không lấy xưởng giao 10");
    assert.equal(o("Trắng", "130").conNo, 8);
  });

  it("ma trận màu × size, ô không cắt để trống", () => {
    const m = maTran(tinhLo(lo(), [ve(1, "2026-11-21", [{ mau: "Đỏ", size: "130", xuong_giao: 16, kho_dem: 16 }])], HOM_NAY))!;
    assert.deepEqual(m.sizes, ["130", "140"]);
    assert.deepEqual(m.hang, [
      { mau: "Đỏ", o: [0, 16], tong: 16 },
      { mau: "Trắng", o: [8, null], tong: 8 },
    ]);
    assert.deepEqual(m.tong, [8, 16]);
    assert.equal(m.tongCong, 24);
  });

  it("hàng về ghi không có size: không lập ma trận, tính theo màu", () => {
    const t = tinhLo(lo(), [ve(1, "2026-10-31", [{ mau: "Đỏ", size: "", xuong_giao: null, kho_dem: 31 }])], HOM_NAY);
    assert.equal(maTran(t), null);
    assert.deepEqual(conNoTheoMau(t).find((x) => x.mau === "Đỏ"), { mau: "Đỏ", soCat: 32, khoDem: 31, conNo: 1 });
    assert.equal(t.conNo, 9);
  });

  it("về thừa cho còn nợ âm, không tính là trễ", () => {
    const t = tinhLo(lo({ dong: [{ mau: "Đen", size: "160", so_cat: 85 }] }), [ve(1, "2026-11-13", [{ mau: "Đen", size: "160", xuong_giao: 95, kho_dem: 95 }])], HOM_NAY);
    assert.equal(t.conNo, -10);
    assert.equal(t.ngayTre, 0);
    assert.equal(nhanLo(t, HOM_NAY).t, "Đủ lô");
    assert.equal(conChoVe(t), false);
  });
});

describe("ngày trễ hẹn", () => {
  const tre = (over: Partial<LoCat>, hangVe: HangVe[] = []) => tinhLo(lo(over), hangVe, HOM_NAY);
  it("đếm ngày theo lịch", () => {
    assert.equal(soNgay("2026-11-19", "2026-11-21"), 2);
    assert.equal(soNgay("2026-10-30", "2026-11-02"), 3);
    assert.equal(soNgay("2026-11-25", "2026-11-21"), -4);
  });
  it("giờ Việt Nam: 17h UTC đã sang ngày hôm sau", () => {
    assert.equal(homNayVN(new Date("2026-11-21T16:59:00Z")), "2026-11-21");
    assert.equal(homNayVN(new Date("2026-11-21T17:00:00Z")), "2026-11-22");
  });
  it("quá hẹn mà còn nợ thì trễ", () => {
    const t = tre({ hen_tra: "2026-11-19" });
    assert.equal(t.ngayTre, 2);
    assert.deepEqual(nhanLo(t, HOM_NAY), { k: "late", t: "Trễ 2 ngày" });
  });
  it("hẹn hôm nay, hẹn sau này, chưa hẹn: không trễ", () => {
    assert.equal(tre({ hen_tra: HOM_NAY }).ngayTre, 0);
    assert.equal(nhanLo(tre({ hen_tra: HOM_NAY }), HOM_NAY).t, "Hẹn hôm nay");
    assert.equal(tre({ hen_tra: "2026-11-25" }).ngayTre, 0);
    assert.equal(nhanLo(tre({ hen_tra: "2026-11-25" }), HOM_NAY).t, "Còn 4 ngày");
    assert.equal(tre({ hen_tra: null }).ngayTre, 0);
    assert.equal(nhanLo(tre({ hen_tra: null }), HOM_NAY).t, "Chưa hẹn ngày");
  });
  it("đủ lô, chưa đối soát, đã đóng lô: không trễ dù quá hẹn", () => {
    const du = tre({ hen_tra: "2026-11-18" }, [ve(1, "2026-11-20", [
      { mau: "Đỏ", size: "130", xuong_giao: 16, kho_dem: 16 },
      { mau: "Đỏ", size: "140", xuong_giao: 16, kho_dem: 16 },
      { mau: "Trắng", size: "130", xuong_giao: 8, kho_dem: 8 },
    ])]);
    assert.equal(du.conNo, 0);
    assert.equal(du.ngayTre, 0);
    assert.equal(tre({ hen_tra: "2026-11-18", trang_thai: "chua_doi_soat" }).ngayTre, 0);
    assert.equal(nhanLo(tre({ trang_thai: "chua_doi_soat" }), HOM_NAY).t, "Chưa đối soát");
    assert.equal(tre({ hen_tra: "2026-11-18", trang_thai: "dong" }).ngayTre, 0);
    assert.equal(nhanLo(tre({ trang_thai: "dong" }), HOM_NAY).t, "Đóng lô · thiếu 40");
  });
});

describe("lịch sử dời hẹn", () => {
  it("giữ ngày hẹn đầu và số lần dời; ngày trễ tính theo hẹn hiện tại", () => {
    const t = tinhLo(lo({
      hen_tra: "2026-11-20",
      doi_hen: [
        { hen_cu: "2026-11-18", hen_moi: "2026-11-19", ly_do: "xưởng gặp vấn đề" },
        { hen_cu: "2026-11-19", hen_moi: "2026-11-20", ly_do: "chờ in" },
      ],
    }), [], HOM_NAY);
    assert.equal(t.henDau, "2026-11-18");
    assert.equal(t.soLanDoiHen, 2);
    assert.equal(t.ngayTre, 1);
  });
  it("chưa dời lần nào thì hẹn đầu là hẹn hiện tại", () => {
    const t = tinhLo(lo(), [], HOM_NAY);
    assert.equal(t.henDau, "2026-11-19");
    assert.equal(t.soLanDoiHen, 0);
  });
});

describe("tóm tắt, phiếu chờ cắt, nhật ký", () => {
  const los = [
    lo(),
    lo({ id: 2, ma_hang: "QD26002", lo: "L2", hen_tra: null, trang_thai: "chua_doi_soat", dong: [{ mau: "Đen", size: "160", so_cat: 97 }] }),
    lo({ id: 3, ma_hang: "QD26001", lo: "L5", hen_tra: "2026-11-25", phieu_dat_id: 7, dong: [{ mau: "Be", size: "140", so_cat: 300 }] }),
  ];
  const hangVe = [
    ve(1, "2026-11-20", [{ mau: "Đỏ", size: "130", xuong_giao: 5, kho_dem: null }]),
    ve(2, HOM_NAY, [{ mau: "Đỏ", size: "130", xuong_giao: 4, kho_dem: 4 }, { mau: "Trắng", size: "130", xuong_giao: 8, kho_dem: 8 }], { so_phieu_pancake: "1002", nguoi_ky: "Kho A" }),
    ve(3, HOM_NAY, [{ mau: "Đỏ", size: "140", xuong_giao: 6, kho_dem: 6 }], { khong_nhap_pancake: true }),
  ];
  const phieu: PhieuDat[] = [
    { id: 7, ma_hang: "QD26001", dot: "L5", trang_thai: "cho_cat", dong: [{ mau: "Be", size: "", so_luong: 500 }] },
    { id: 8, ma_hang: "ADT25003", dot: "", trang_thai: "cho_cat", dong: [{ mau: "", size: "", so_luong: 730 }] },
    { id: 9, ma_hang: "BD24066", dot: "", trang_thai: "huy", dong: [{ mau: "", size: "", so_luong: 338 }] },
  ];
  it("phiếu chờ cắt = số đặt − số đã cắt của lô nối với phiếu; bỏ phiếu hủy", () => {
    assert.deepEqual(phieuChoCat(phieu, los).map((x) => [x.p.id, x.soDat, x.daCat, x.conCho]), [[7, 500, 300, 200], [8, 730, 0, 730]]);
  });
  it("tóm tắt: lô chưa đối soát không tính nợ; về hôm nay chỉ tính số kho đếm", () => {
    const tienDo = los.map((l) => tinhLo(l, hangVe, HOM_NAY));
    assert.deepEqual(tomTat(tienDo, hangVe, phieuChoCat(phieu, los), HOM_NAY), {
      loTre: 1, conNo: 22 + 300, veHomNay: 18, phieuHomNay: 1, choCat: 930, choKhoDem: 5,
    });
    assert.deepEqual(xepLo(tienDo).map((t) => t.lo.id), [1, 3, 2]);
  });
  it("nhật ký gom theo ngày, mới nhất trước", () => {
    const n = nhatKy(hangVe, los);
    assert.deepEqual(n.map((d) => [d.ngay, d.khoDem, d.choKhoDem, d.lan.length]), [[HOM_NAY, 18, 0, 2], ["2026-11-20", 0, 5, 1]]);
    assert.equal(moTaLanVe(hangVe[1]), "Đỏ 130: 4 · Trắng 130: 8");
    assert.equal(nhanPancake(hangVe[1]), "Pancake #1002");
    assert.equal(nhanPancake(hangVe[2]), "Không nhập Pancake");
    assert.equal(nhanPancake(hangVe[0]), "Chưa nhập Pancake");
  });
});

describe("kiểm tra đầu vào công cụ ghi", () => {
  const dong = [{ mau: "Đỏ", size: "130", xuong_giao: 4, kho_dem: 4 }];
  const moi = { ma_hang: "ADT26001", lo: "L1", ngay: HOM_NAY, lines: dong, nguoi_ky: "Kho A" };
  it("lần hàng về hợp lệ", () => {
    assert.equal(loiHangVe({ ...moi, pancake: "1002" }, HOM_NAY), null);
    assert.equal(loiHangVe({ id: 5, pancake: "1002" }, HOM_NAY), null, "sửa theo id: database kiểm lại trên số đã lưu");
  });
  it("không nhập Pancake trước khi kho thực nhận", () => {
    const chuaDem = [{ mau: "Đỏ", size: "130", xuong_giao: 4, kho_dem: null }];
    assert.match(loiHangVe({ ...moi, lines: chuaDem, pancake: "1002" }, HOM_NAY)!, /Kho chưa đếm đủ/);
    assert.equal(loiHangVe({ ...moi, lines: chuaDem }, HOM_NAY), null, "chưa đếm vẫn ghi được, miễn không có số Pancake");
    assert.match(loiHangVe({ ...moi, nguoi_ky: " ", pancake: "1002" }, HOM_NAY)!, /Thiếu người của kho ký nhận/);
  });
  it("thiếu lô, ngày tương lai, trùng dòng, dòng không số, vừa có phiếu vừa 'không nhập'", () => {
    assert.match(loiHangVe({ ...moi, lo: undefined }, HOM_NAY)!, /cần mã hàng, lô, ngày/);
    assert.match(loiHangVe({ ...moi, ngay: "2026-11-22" }, HOM_NAY)!, /tương lai/);
    assert.match(loiHangVe({ ...moi, lines: [...dong, { mau: "đỏ", size: "130", kho_dem: 1 }] }, HOM_NAY)!, /Trùng dòng/);
    assert.match(loiHangVe({ ...moi, lines: [{ mau: "Đỏ", size: "130" }] }, HOM_NAY)!, /thiếu số lượng/);
    assert.match(loiHangVe({ ...moi, pancake: "1", khong_nhap: true }, HOM_NAY)!, /Chọn một/);
  });

  const ve1 = z.object(arrivalSaveInput);
  it("bắt buộc có nguồn", () => {
    assert.equal(ve1.safeParse({ ...moi }).success, false);
    assert.equal(ve1.safeParse({ ...moi, nguon: "  " }).success, false);
    assert.equal(ve1.safeParse({ ...moi, nguon: "zalo:nhóm xưởng msg 2" }).success, true);
    assert.equal(z.object(lotSaveInput).safeParse({ ma_hang: "ADT26001", lo: "L1" }).success, false);
    assert.equal(z.object(rescheduleInput).safeParse({ ma_hang: "ADT26001", lo: "L1", hen_moi: "2026-11-25", ly_do: "xưởng báo" }).success, false);
  });
  it("số nguyên ép từ chuỗi; null và chuỗi rỗng là CHƯA CÓ SỐ, không phải 0", () => {
    const r = ve1.parse({
      nguon: "phiếu xưởng 21/11", ma_hang: "ADT26001", lo: "L1", ngay: HOM_NAY,
      lines: [{ mau: " Đỏ ", size: 130, xuong_giao: "12", kho_dem: null }, { mau: "Trắng", size: "140", xuong_giao: 3, kho_dem: "" }],
    });
    assert.deepEqual(r.lines, [
      { mau: "Đỏ", size: "130", xuong_giao: 12, kho_dem: undefined },
      { mau: "Trắng", size: "140", xuong_giao: 3, kho_dem: undefined },
    ]);
  });
  it("từ chối số âm, số lẻ, ngày sai dạng, trạng thái lạ", () => {
    const bad = (lines: unknown) => ve1.safeParse({ nguon: "phiếu 1", ma_hang: "ADT26001", lo: "L1", ngay: HOM_NAY, lines }).success;
    assert.equal(bad([{ mau: "Đỏ", size: "130", kho_dem: -1 }]), false);
    assert.equal(bad([{ mau: "Đỏ", size: "130", kho_dem: 1.5 }]), false);
    assert.equal(bad([{ mau: "Đỏ", size: "130", kho_dem: "mười" }]), false);
    assert.equal(bad([]), false);
    assert.equal(ve1.safeParse({ nguon: "phiếu 1", id: 3, ngay: "21/11/2026" }).success, false);
    assert.equal(z.object(lotSaveInput).safeParse({ ma_hang: "ADT26001", lo: "L1", nguon: "sổ cắt", trang_thai: "xong" }).success, false);
  });
});

describe("công cụ MCP mk_sx_*", () => {
  type Tool = { cfg: { inputSchema: z.ZodRawShape }; run: (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> };
  let rpcCalls: { fn: string; args: Record<string, unknown> }[];
  const tools = (access: "read" | "read_write") => {
    const m = new Map<string, Tool>();
    const server = { registerTool: (name: string, cfg: Tool["cfg"], run: Tool["run"]) => m.set(name, { cfg, run }) };
    registerSanXuatTools(server as never, { id: "k1abcdefgh", label: "Thu Hà", access, shopIds: [] } as unknown as ApiKeyContext);
    return m;
  };
  const goi = (t: Map<string, Tool>, name: string, args: unknown) => {
    const tool = t.get(name)!;
    return tool.run(z.object(tool.cfg.inputSchema).parse(args));
  };
  beforeEach(() => {
    rpcCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      rpcCalls.push({ fn: url.pathname.replace("/rest/v1/rpc/", ""), args: JSON.parse(String(init.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });

  it("khóa chỉ đọc chỉ thấy công cụ đọc; không công cụ nào ghi sang Pancake", () => {
    assert.deepEqual([...tools("read").keys()], ["mk_sx_progress", "mk_sx_arrivals", "mk_sx_orders"]);
    assert.deepEqual([...tools("read_write").keys()], [
      "mk_sx_progress", "mk_sx_arrivals", "mk_sx_orders",
      "mk_sx_order_save", "mk_sx_lot_save", "mk_sx_lot_reschedule", "mk_sx_arrival_save",
    ]);
    const src = fs.readFileSync("src/lib/san-xuat-tools.ts", "utf8");
    assert.deepEqual([...src.matchAll(/call\("(\w+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith("mk_sx_")), []);
    assert.ok(!/from "\.\/(shopee|facebook|video)/.test(src));
  });

  it("đổi ngày hẹn gọi đúng hàm, kèm người ghi và nguồn", async () => {
    const r = await goi(tools("read_write"), "mk_sx_lot_reschedule", {
      ma_hang: "ADT26001", lo: "L1", hen_moi: "2026-11-25", ly_do: "QLSX xưởng báo dời", nguon: "zalo:nhóm xưởng msg 1",
    });
    assert.ok(!r.isError);
    assert.deepEqual(rpcCalls, [{
      fn: "mk_sx_lot_reschedule",
      args: { p_agent: "Thu Hà", p_ma_hang: "ADT26001", p_lo: "L1", p_hen_moi: "2026-11-25", p_ly_do: "QLSX xưởng báo dời", p_nguon: "zalo:nhóm xưởng msg 1" },
    }]);
  });

  it("ghi số Pancake khi kho chưa đếm: báo lỗi, không gọi database", async () => {
    const r = await goi(tools("read_write"), "mk_sx_arrival_save", {
      nguon: "phiếu xưởng 20/11", ma_hang: "ADT26001", lo: "L1", ngay: "2026-11-20", nguoi_ky: "Kho A", pancake: "1001",
      lines: [{ mau: "Đỏ", size: "130", xuong_giao: 1 }],
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Kho chưa đếm đủ/);
    assert.equal(rpcCalls.length, 0);
  });

  it("tham số gửi đi đều có trong chữ ký hàm của migration", async () => {
    const t = tools("read_write");
    await goi(t, "mk_sx_progress", {});
    await goi(t, "mk_sx_arrivals", {});
    await goi(t, "mk_sx_orders", {});
    await goi(t, "mk_sx_order_save", { ma_hang: "ADT26002", dot: "L2", nguon: "PĐH-THỬ-01", lines: [{ mau: "Đỏ", size: "", so_luong: 500 }] });
    await goi(t, "mk_sx_lot_save", { ma_hang: "ADT26001", lo: "L1", nguon: "sổ cắt xưởng", lines: [{ mau: "Đỏ", size: "130", so_cat: 16 }] });
    await goi(t, "mk_sx_lot_reschedule", { ma_hang: "ADT26001", lo: "L1", hen_moi: "2026-11-25", ly_do: "xưởng báo", nguon: "zalo 1" });
    await goi(t, "mk_sx_arrival_save", { nguon: "phiếu 1", ma_hang: "ADT26001", lo: "L1", ngay: "2026-11-20", lines: [{ mau: "Đỏ", size: "130", kho_dem: 1 }] });
    assert.equal(rpcCalls.length, 7);
    const sql = fs.readFileSync("supabase/migrations/0025_san_xuat.sql", "utf8");
    for (const c of rpcCalls) {
      const m = sql.match(new RegExp(`create or replace function public\\.${c.fn}\\(([^)]*)\\)`));
      assert.ok(m, `migration thiếu hàm ${c.fn}`);
      const params = [...m[1].matchAll(/\b(p_\w+)\s/g)].map((x) => x[1]);
      for (const k of Object.keys(c.args)) assert.ok(params.includes(k), `${c.fn} không có tham số ${k}`);
      assert.ok(Object.keys(c.args).includes("p_agent"));
      const types = m[1].split(",").map((p) => p.trim().split(/\s+/)[1]).join(",");
      assert.ok(sql.includes(`'${c.fn}(${types})'`), `${c.fn}(${types}) chưa nằm trong danh sách thu quyền`);
    }
  });
});

describe("script nạp số đầu", () => {
  it("đọc CSV có ngoặc kép, số, ngày", () => {
    assert.deepEqual(docCsv('a,"b, c","d ""e"""\r\n1,,3\n'), [["a", "b, c", 'd "e"'], ["1", "", "3"]]);
    assert.equal(so("1.234"), 1234);
    assert.equal(so(""), null);
    assert.equal(so("#REF!"), null);
    assert.equal(ngayIso("9/11/2026"), "2026-11-09");
    assert.equal(ngayIso("10/8"), null);
  });

  const LO_CAT = [
    ["PHIẾU LÔ CẮT"],
    ["Mã lô (tự ghép)", "Mã hàng", "Lô", "Màu", "SL đặt", "Lên đơn", "Ngày cắt", "130", "140", "Tổng cắt (tự tính)", "Giao kho dự kiến", "Đã về kho (tự tính)", "Ghi chú"],
    ["", "ADT26001", "L1", "Đỏ", "", "12/11/2026", "", "16", "16", "32", "19/11/2026", "13", "đang in"],
    ["", "ADT26001", "L1", "Trắng", "", "12/11/2026", "", "8", "", "8", "19/11/2026", "8", ""],
    ["", "QD26002", "L2", "Đen", "", "", "", "", "97", "97", "", "0", ""],
    ["", "BD26011", "L2", "Chưa rõ", "", "13/11/2026", "", "", "", "0", "21/11/2026", "0", "Chờ cắt"],
    ["", "ADT26002", "L2", "Đỏ", "500", "17/11/2026", "19/11/2026", "", "", "0", "", "0", "Chờ số áo cắt"],
  ];
  const HANG_VE = [
    ["Ngày giao", "Mã hàng", "Lô", "Màu", "Size", "SL xưởng giao", "SL kho đếm", "Số tính về kho (tự tính)", "Lệch", "Kho nhận", "Xưởng xác nhận", "Ghi chú"],
    ["20/11/2026", "ADT26001", "L1", "Đỏ", "130", "5", "", "5", "", "", "QLSX xưởng", "Phiếu xuất xưởng 20/11. Pancake #1001. Kho đã ký"],
    ["21/11/2026", "ADT26001", "L1", "Đỏ", "130", "4", "4", "4", "0", "Kho A", "Xưởng B", "Phiếu xưởng 21/11 Lần 2. Pancake #1002"],
    ["21/11/2026", "ADT26001", "L1", "Trắng", "130", "8", "8", "8", "0", "Kho A", "Xưởng B", ""],
    ["21/11/2026", "ADT26001", "L1", "Đỏ", "130", "2", "2", "", "", "Kho A", "Xưởng B", ""],
    ["07/10/2026", "QD26002", "L2", "Đen", "140", "66", "", "", "", "", "Sổ cắt xưởng", ""],
    ["", "QD26002", "L2", "Đen", "140", "5", "", "", "", "", "Sổ cắt xưởng", "ngày sai"],
    ["21/11/2026", "BD26011", "L2", "Xanh than", "140", "44", "44", "44", "0", "Kho A", "Xưởng B", "Pancake #1003"],
  ];
  const kh = lapKeHoach(LO_CAT, HANG_VE);

  it("lô chưa có số cắt không được tạo; SL đặt thành phiếu đặt chờ cắt", () => {
    assert.deepEqual(kh.los.map((l) => `${l.ma_hang} ${l.lo}`), ["ADT26001 L1", "QD26002 L2"]);
    assert.deepEqual(kh.phieu.map((p) => [p.ma_hang, p.dot, p.trang_thai, p.lines[0].so_luong, p.ngay_dat]), [["ADT26002", "L2", "cho_cat", 500, "2026-11-17"]]);
    assert.ok(kh.canhBao.some((x) => /BD26011 L2 .*chưa có số cắt/.test(x)));
    assert.equal(kh.los[0].hen_tra, "2026-11-19");
    assert.deepEqual(kh.los[0].lines, [
      { mau: "Đỏ", size: "130", so_cat: 16 }, { mau: "Đỏ", size: "140", so_cat: 16 }, { mau: "Trắng", size: "130", so_cat: 8 },
    ]);
  });

  it("hàng về cho lô chưa có số cắt và dòng không ngày: không nạp, có cảnh báo, vẫn hiện trong tổng đã về", () => {
    assert.ok(!kh.hangVe.some((v) => v.ma_hang === "BD26011"));
    assert.ok(kh.canhBao.some((x) => /BD26011 L2 có hàng về .*KHÔNG nạp/.test(x)));
    assert.ok(kh.canhBao.some((x) => /QD26002 L2 có 1 dòng không có ngày giao/.test(x)));
    assert.deepEqual(kh.daVe.find((d) => d.ma_hang === "BD26011"), { ma_hang: "BD26011", lo: "L2", daVe: 44, chuaNap: 44 });
  });

  it("số kho đếm lấy cột 'Số tính về kho'; dòng có G mà H trống là dòng trùng, bỏ qua", () => {
    const adt = kh.hangVe.filter((v) => v.ma_hang === "ADT26001");
    assert.deepEqual(adt.map((v) => [v.ngay, v.lines.map((x) => x.kho_dem), v.pancake, v.nguoi_ky]), [
      ["2026-11-20", [5], null, null],
      ["2026-11-21", [4, 8], "1002", "Kho A"],
    ]);
    assert.match(adt[1].nguon, /tab "Giao hàng về kho", dòng 3, 4/);
    assert.deepEqual(kh.boQua.length, 1);
    assert.match(kh.boQua[0], /dòng 5: .*Đỏ 130: xưởng giao 2, kho đếm 2, "Số tính về kho" trống → coi là dòng ghi trùng/);
    assert.ok(kh.canhBao.some((x) => /dòng 2: .*cột kho đếm trống, lấy 5 theo "Số tính về kho"/.test(x)));
    assert.ok(kh.canhBao.some((x) => /#1001 nhưng kho chưa đếm đủ hoặc chưa có người ký/.test(x)), "không có người kho ký thì không ghi số Pancake");
  });

  it("dự báo: lô chỉ có số sổ xưởng là chưa đối soát, không tính đã về; nêu chỗ lệch với sheet", () => {
    const { tienDo, lech } = duBao(kh, HOM_NAY);
    const adt = tienDo[0];
    assert.equal(adt.soCat, 40);
    assert.equal(adt.khoDem, 17);
    assert.equal(adt.choKhoDem, 0);
    assert.equal(adt.conNo, 23);
    assert.equal(adt.ngayTre, 2);
    assert.equal(kh.los[1].trang_thai, "chua_doi_soat");
    assert.equal(tienDo[1].khoDem, 0);
    assert.equal(tienDo[1].choKhoDem, 66);
    assert.equal(tienDo[1].ngayTre, 0);
    assert.ok(lech.some((x) => /ADT26001 L1 Đỏ: sheet ghi "Đã về kho" 13, script tính được 9/.test(x)), lech.join("\n"));
  });

  // Dựng lại các ca Thu Hà soát 22/11/2026 trên tab "Giao hàng về kho" (số mẫu, cùng tổng với số kỳ vọng).
  describe("tổng đã về theo lô so với số kỳ vọng", () => {
    const TD = HANG_VE[0];
    const cat = (ma: string, lo: string, mau: string, n: number) => ["", ma, lo, mau, "", "", "", "", String(n), String(n), "", "0", ""];
    const LO = [LO_CAT[1],
      cat("ADT26001", "L1", "Đỏ", 396), cat("QD26001", "L3", "Đen", 469), cat("QD26001", "L4", "Đen", 464),
      cat("QD26033", "L1", "Đen", 205), cat("ADT26002", "L1", "Xanh than", 525), cat("ADT25002", "Tái 27/10", "Trắng", 845),
      cat("ADT25003", "Tái 23/10", "Ghi", 680), cat("QD26002", "L2", "Đen", 291), cat("QN25004", "Tái 15/9", "Xanh", 368),
    ];
    // [ngày, mã, lô, màu, size, F xưởng giao, G kho đếm, H số tính về kho]
    const dong = (r: (string | number)[]) => [...r.map(String), "", "Kho", "", ""];
    const VE = [TD,
      // Ca 2: G trống nhưng hàng đã về, kho đã ký, H có số → lấy H.
      dong(["20/11/2026", "ADT26001", "L1", "Đỏ", "140", 48, "", 48]),
      dong(["21/11/2026", "ADT26001", "L1", "Đỏ", "140", 47, 47, 47]),
      dong(["20/11/2026", "ADT26002", "L1", "Xanh than", "140", 74, "", 74]),
      dong(["11/11/2026", "ADT26002", "L1", "Xanh than", "140", 445, 445, 445]),
      dong(["19/11/2026", "QD26033", "L1", "Đen", "140", 93, "", 93]),
      dong(["20/11/2026", "QD26033", "L1", "Đen", "140", 112, 112, 112]),
      // Ca 1: G có số, H trống, F có số → dòng trùng (tổng 129), không tính.
      dong(["13/11/2026", "QD26001", "L3", "Be", "140", 13, 13, ""]),
      dong(["13/11/2026", "QD26001", "L3", "Be", "170", 9, 9, ""]),
      dong(["13/11/2026", "QD26001", "L3", "Đen", "150", 19, 19, ""]),
      dong(["13/11/2026", "QD26001", "L3", "Đen", "160", 30, 30, ""]),
      dong(["13/11/2026", "QD26001", "L3", "Đen", "170", 37, 37, ""]),
      dong(["13/11/2026", "QD26001", "L3", "Đen", "180", 21, 21, ""]),
      dong(["14/11/2026", "QD26001", "L3", "Đen", "140", 342, 342, 342]),
      dong(["18/11/2026", "QD26001", "L4", "Đen", "140", 161, 161, 161]),
      dong(["21/11/2026", "QD26001", "L4", "Đen", "160", 74, 74, 74]),
      // Lô có hàng về nhưng chưa có số cắt.
      dong(["21/11/2026", "BD26011", "L2", "Xanh than", "140", 186, 186, 186]),
      dong(["09/11/2026", "ADT25002", "Tái 27/10", "Trắng", "140", 838, 838, 838]),
      // Ngoại lệ: H trống và F trống mà G có số → lấy G.
      dong(["31/10/2026", "ADT25003", "Tái 23/10", "Xanh than", "", "", 319, ""]),
      dong(["31/10/2026", "ADT25003", "Tái 23/10", "Ghi", "", "", 360, ""]),
      // Chỉ có số sổ cắt xưởng ở cột F: chưa đối soát, không tính là đã về.
      dong(["07/10/2026", "QD26002", "L2", "Đen", "160", 238, "", ""]),
      dong(["06/10/2026", "QN25004", "Tái 15/9", "Xanh", "160", 174, "", ""]),
    ];
    const KY_VONG = {
      "ADT26001 L1": 95, "QD26001 L3": 342, "QD26001 L4": 235, "BD26011 L2": 186, "QD26033 L1": 205,
      "ADT26002 L1": 519, "ADT25002 tái 27/10": 838, "ADT25003": 679,
    };
    const k = lapKeHoach(LO, VE);

    it("cả 8 lô ra đúng số kỳ vọng", () => {
      const ss = soKyVong(k.daVe, KY_VONG);
      assert.deepEqual(ss.map((x) => [x.lo, x.daVe, x.lech]), Object.entries(KY_VONG).map(([lo, n]) => [lo, n, 0]));
    });

    it("6 dòng trùng của QD26001 L3 (129 cái) bị bỏ qua và được liệt kê", () => {
      assert.equal(k.boQua.length, 6);
      assert.ok(k.boQua.every((x) => /QD26001 L3/.test(x)));
      const l3 = duBao(k, HOM_NAY).tienDo.find((t) => t.lo.ma_hang === "QD26001" && t.lo.lo === "L3")!;
      assert.equal(l3.khoDem, 342);
      assert.ok(l3.khoDem <= l3.soCat);
    });

    it("QD26002 và QN25004 nạp ở trạng thái chưa đối soát, đã về = 0", () => {
      for (const ma of ["QD26002", "QN25004"]) {
        assert.equal(k.los.find((l) => l.ma_hang === ma)!.trang_thai, "chua_doi_soat");
        assert.equal(k.daVe.find((d) => d.ma_hang === ma)!.daVe, 0);
      }
      const { tienDo } = duBao(k, HOM_NAY);
      assert.equal(tienDo.find((t) => t.lo.ma_hang === "QD26002")!.choKhoDem, 238);
    });

    it("lệch với kỳ vọng và lô không thấy trong sheet đều được nêu rõ", () => {
      assert.deepEqual(soKyVong(k.daVe, { "ADT26001 L1": 96, "QD26001 L3": 471, "XX99999 L1": 10 }), [
        { lo: "ADT26001 L1", kyVong: 96, daVe: 95, lech: -1 },
        { lo: "QD26001 L3", kyVong: 471, daVe: 342, lech: -129 },
        { lo: "XX99999 L1", kyVong: 10, daVe: null, lech: null },
      ]);
    });
  });
});
