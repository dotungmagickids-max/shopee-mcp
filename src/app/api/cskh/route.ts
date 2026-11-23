import { timingSafeEqual } from "node:crypto";
import { pancakeStock } from "@/lib/kho";
import { cached, validDay } from "@/lib/kho-store";
import { congNgay, layNgay, layXuHuong, ngayVN, tenPage, tinhLaiNgay } from "@/lib/cskh/data";
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
    const k = (sp.get("moi") ? null : await layNgay(ngay)) ?? (await tinhLaiNgay(ngay));
    let ton: ReturnType<typeof tonTheoMa> = {};
    let tonLoi = "";
    try {
      const s = await cached("tonpancake3", 10 * 60_000, pancakeStock, (v) => v.stock.length > 0);
      ton = tonTheoMa(k.ma.map((m) => m.ma), s.stock);
    } catch (err) {
      tonLoi = err instanceof Error ? err.message : String(err);
    }
    return json({ ...k, tenPage: tenPage(), ton, tonLoi });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
}
