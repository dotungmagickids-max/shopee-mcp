import { kiemMatKhau, taoVe } from "@/lib/xuong";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Đăng nhập trang /xuong bằng mật khẩu chung. Thân JSON: { mat_khau }.
 * Đúng → { ok: true, ve, han }: trang lưu vé và gửi vé trong header x-mk-key thay cho mã.
 * Sai → 401 sau khoảng 1 giây (làm chậm việc dò mật khẩu).
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Thân yêu cầu không phải JSON" }, 400);
  }
  const kq = kiemMatKhau((body as { mat_khau?: unknown } | null)?.mat_khau);
  if (kq === "unset") return json({ error: "Trang xưởng chưa bật" }, 503);
  if (kq === "bad") {
    await new Promise((r) => setTimeout(r, 1000));
    return json({ error: "Mật khẩu không đúng" }, 401);
  }
  return json({ ok: true, ...taoVe() });
}
