/**
 * Nạp số đầu cho Sổ hàng xưởng từ file SX.
 *
 *   1. Trong Google Sheet file SX, tải tab "Phiếu lô cắt" và tab "Giao hàng về kho" về dạng CSV
 *      (Tệp → Tải xuống → CSV), hoặc lưu kết quả Sheets API ({ values: [[…]] }) thành .json.
 *   2. Chạy thử (mặc định, KHÔNG ghi gì, không cần khóa Supabase):
 *        npx tsx scripts/sx-nap-so-dau.ts --lo-cat lo-cat.csv --hang-ve hang-ve.csv
 *   3. Sau khi anh duyệt migration 0024 và duyệt số chạy thử, mới nạp thật:
 *        npx tsx scripts/sx-nap-so-dau.ts --lo-cat lo-cat.csv --hang-ve hang-ve.csv --ghi
 *
 * Nạp thật gọi các hàm mk_sx_* (cùng đường với công cụ MCP), nên mọi luật kiểm tra và nhật ký vẫn chạy.
 * Chạy lại an toàn: phiếu đặt và lô cắt ghi đè theo khóa; lần hàng về trùng (lô, ngày, nguồn) bị từ chối.
 * Không có bước nào ghi sang Pancake.
 */
import fs from "node:fs";
import { homNayVN } from "../src/lib/san-xuat";
import { docBang, duBao, lapKeHoach } from "./lib/sx-seed";

function thamSo(ten: string): string | undefined {
  const i = process.argv.indexOf(ten);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fLoCat = thamSo("--lo-cat");
const fHangVe = thamSo("--hang-ve");
const ghi = process.argv.includes("--ghi");
if (!fLoCat || !fHangVe) {
  console.error("Cách dùng: npx tsx scripts/sx-nap-so-dau.ts --lo-cat <file.csv|.json> --hang-ve <file.csv|.json> [--ghi]");
  process.exit(1);
}

const kh = lapKeHoach(docBang(fs.readFileSync(fLoCat, "utf8"), fLoCat), docBang(fs.readFileSync(fHangVe, "utf8"), fHangVe));
const homNay = homNayVN();
const { tienDo, lech } = duBao(kh, homNay);
const cot = (s: string | number, n: number) => String(s).padEnd(n);
const phai = (s: string | number, n: number) => String(s).padStart(n);

console.log(`\n=== ${ghi ? "NẠP THẬT" : "CHẠY THỬ (không ghi gì)"} · hôm nay ${homNay} ===`);
console.log(`\nSẽ nạp: ${kh.phieu.length} phiếu đặt, ${kh.los.length} lô cắt, ${kh.hangVe.length} lần hàng về.`);

console.log("\n--- Lô cắt và số sẽ hiện trên trang ---");
console.log(`${cot("Mã hàng", 10)}${cot("Lô", 12)}${phai("Cắt", 6)}${phai("Kho đếm", 9)}${phai("Chờ đếm", 9)}${phai("Còn nợ", 8)}${phai("Trễ", 5)}  Hẹn trả    Trạng thái`);
for (const t of tienDo) {
  console.log(
    `${cot(t.lo.ma_hang, 10)}${cot(t.lo.lo, 12)}${phai(t.soCat, 6)}${phai(t.khoDem, 9)}${phai(t.choKhoDem, 9)}${phai(t.conNo, 8)}${phai(t.ngayTre, 5)}  ${cot(t.lo.hen_tra ?? "chưa hẹn", 10)} ${t.lo.trang_thai}`
  );
}
const mo = tienDo.filter((t) => t.lo.trang_thai === "dang_ve" && t.conNo > 0);
console.log(`Tổng còn nợ (lô đang về): ${mo.reduce((a, t) => a + t.conNo, 0)} cái · ${mo.filter((t) => t.ngayTre > 0).length} lô trễ hẹn.`);

console.log("\n--- Phiếu đặt ---");
for (const p of kh.phieu) {
  console.log(`${cot(p.ma_hang, 10)}${cot(p.dot, 12)}${phai(p.lines.reduce((a, x) => a + x.so_luong, 0), 6)}  ${p.trang_thai}  đặt ${p.ngay_dat ?? "?"}`);
}

console.log("\n--- Lần hàng về ---");
for (const v of kh.hangVe) {
  const xuong = v.lines.reduce((a, x) => a + (x.xuong_giao ?? 0), 0);
  const kho = v.lines.reduce((a, x) => a + (x.kho_dem ?? 0), 0);
  const cho = v.lines.some((x) => x.kho_dem == null);
  console.log(
    `${v.ngay}  ${cot(v.ma_hang, 10)}${cot(v.lo, 12)}xưởng ${phai(xuong, 4)}  kho ${phai(cho ? "chờ" : kho, 4)}  ký: ${cot(v.nguoi_ky ?? "—", 10)} ${v.pancake ? `Pancake #${v.pancake}` : ""}`
  );
}

console.log(`\n--- Chỗ lệch so với sheet (${lech.length}) ---`);
for (const x of lech) console.log(`• ${x}`);
console.log(`\n--- Cảnh báo khi đọc sheet (${kh.canhBao.length}) ---`);
for (const x of kh.canhBao) console.log(`• ${x}`);

if (!ghi) {
  console.log("\nChạy thử xong, chưa ghi gì. Thêm --ghi để nạp thật (chỉ sau khi anh duyệt).");
  process.exit(0);
}

// ---------- Nạp thật ----------
const { loadEnv } = await import("./lib/env-file");
loadEnv();
const { db } = await import("../src/lib/supabase");
const AGENT = "Thu Hà (nạp số đầu)";
let loi = 0;
async function goi(fn: string, args: Record<string, unknown>, ten: string): Promise<void> {
  const { error } = await db().rpc(fn, { p_agent: AGENT, ...args });
  if (error) {
    loi++;
    console.error(`✗ ${ten}: ${error.message}`);
  } else console.log(`✓ ${ten}`);
}

for (const p of kh.phieu) {
  await goi("mk_sx_order_save", {
    p_ma_hang: p.ma_hang, p_dot: p.dot, p_nguon: p.nguon, p_lines: p.lines, p_ngay_dat: p.ngay_dat,
    p_trang_thai: p.trang_thai, p_ghi_chu: p.ghi_chu,
  }, `phiếu đặt ${p.ma_hang} ${p.dot}`);
}
for (const l of kh.los) {
  await goi("mk_sx_lot_save", {
    p_ma_hang: l.ma_hang, p_lo: l.lo, p_nguon: l.nguon, p_lines: l.lines, p_ngay_cat: l.ngay_cat, p_hen_tra: l.hen_tra,
    p_dot_dat: l.dot_dat, p_trang_thai: l.trang_thai, p_ghi_chu: l.ghi_chu,
  }, `lô cắt ${l.ma_hang} ${l.lo}`);
}
for (const v of kh.hangVe) {
  await goi("mk_sx_arrival_save", {
    p_nguon: v.nguon, p_ma_hang: v.ma_hang, p_lo: v.lo, p_ngay: v.ngay, p_lines: v.lines, p_nguoi_ky: v.nguoi_ky,
    p_pancake: v.pancake, p_ghi_chu: v.ghi_chu,
  }, `hàng về ${v.ngay} ${v.ma_hang} ${v.lo}`);
}
console.log(loi ? `\nXong, có ${loi} dòng lỗi (xem ✗ ở trên).` : "\nNạp xong, không lỗi.");
process.exit(loi ? 1 : 0);
