import { timingSafeEqual } from "node:crypto";
import { pancakeStock } from "@/lib/kho";
import { cached, validDay } from "@/lib/kho-store";
import { congNgay, layNgay, layXuHuong, ngayVN, tenPage, tinhLaiNgay } from "@/lib/cskh/data";
import { layCham } from "@/lib/cskh/cham-data";
import { tonTheoMa } from "@/lib/cskh/ton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function checkKey(request: Request): "ok" | "unset" | "bad" {
  const secret = process.env.CSKH_API_KEY?.trim();
  if (!secret) return "unset";
  const a = Buffer.from(request.headers.get("x-mk-key") ?? "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

/**
 * Trang Quản lý chất lượng CSKH. CHỈ ĐỌC, chỉ có GET. Header bắt buộc: x-mk-key: <CSKH_API_KEY>
 *   GET /api/cskh?ngay=YYYY-MM-DD        → số của một ngày (mặc định hôm qua), kèm tồn kho của các mã được hỏi
 *   GET /api/cskh?ngay=…&moi=1           → tính lại từ dữ liệu đã đồng bộ thay vì dùng bản chụp
 *   GET /api/cskh?xuhuong=30&ngay=…      → dòng gọn của N ngày tính đến `ngay` (tối đa 90)
 * Không trả tên, SĐT, nội dung tin của khách; hội thoại chỉ hiện 5 ký tự cuối của mã.
 * Riêng danh sách "việc với từng khách" và "phản hồi xấu" có đường dẫn mở cuộc chat trong Pancake (chỉ người có quyền vào page mới mở được).
 */
export async function GET(request: Request) {
  const auth = checkKey(request);
  if (auth === "unset") return json({ error: "Chưa đặt CSKH_API_KEY" }, 503);
  if (auth === "bad") return json({ error: "unauthorized" }, 401);
  const sp = new URL(request.url).searchParams;
  const ngay = sp.get("ngay") || congNgay(ngayVN(), -1);
  if (!validDay(ngay)) return json({ error: "ngay phải có dạng YYYY-MM-DD" }, 400);
  try {
    const n = Number(sp.get("xuhuong"));
    if (n > 0) return json({ den: ngay, ngay: await layXuHuong(congNgay(ngay, -(Math.min(90, Math.floor(n)) - 1)), ngay) });
    let k = (sp.get("moi") ? null : await layNgay(ngay)) ?? (await tinhLaiNgay(ngay));
    // Bản chụp cũ chưa có mã hội thoại nên không khớp được điểm chấm: tính lại một lần.
    if (k.cuoc.length && !k.cuoc[0].id) k = await tinhLaiNgay(ngay);
    let ton: ReturnType<typeof tonTheoMa> = {};
    let tonLoi = "";
    try {
      const s = await cached("tonpancake3", 10 * 60_000, pancakeStock, (v) => v.stock.length > 0);
      ton = tonTheoMa(k.ma.map((m) => m.ma), s.stock);
    } catch (err) {
      tonLoi = err instanceof Error ? err.message : String(err);
    }
    // Mã hội thoại đầy đủ không in ra trang; chỉ đổi thành đường dẫn mở Pancake ở hai danh sách cần sale xử lý.
    const link = (page: string, id: string) => `https://pancake.vn/${encodeURIComponent(page)}?c_id=${encodeURIComponent(id)}`;
    const g = await layCham(k);
    const boId = <T extends { page: string; id: string }>(xs: T[]) => xs.map(({ id, ...r }) => ({ ...r, link: link(r.page, id) }));
    const cham = g ? { ...g, viec: boId(g.viec), xau: boId(g.xau) } : null;
    return json({ ...k, cuoc: k.cuoc.map(({ id: _id, ...r }) => r), tenPage: tenPage(), ton, tonLoi, cham });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
