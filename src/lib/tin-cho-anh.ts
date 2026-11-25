import { db } from "./supabase";

/**
 * Hộp tin cho anh (25/11/2026): anh không đọc Telegram nữa. Tin máy chủ gửi vào chat mặc định được lưu thêm ở
 * bảng tin_cho_anh để lịch "chuyen-tin-may-chu" gom lại, nhờ Minh Anh nhắn Zalo riêng anh. Lưu lỗi thì bỏ qua,
 * không làm hỏng việc gửi Telegram.
 */
export function boHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export async function luuTinChoAnh(
  nguon: string,
  html: string,
  opts: { coNut?: boolean; tgMessageId?: number | null } = {}
): Promise<void> {
  try {
    const noi_dung = boHtml(html).slice(0, 4000);
    if (!noi_dung) return;
    await db()
      .from("tin_cho_anh")
      .insert({ nguon, noi_dung, co_nut: !!opts.coNut, tg_message_id: opts.tgMessageId ?? null });
  } catch {
    // chưa có bảng (chưa áp migration 0041) hoặc lỗi mạng: bỏ qua
  }
}

export type TinChoAnh = { id: number; created_at: string; nguon: string; noi_dung: string; co_nut: boolean };

export async function docTinChuaChuyen(toiDa = 30): Promise<TinChoAnh[]> {
  const { data, error } = await db()
    .from("tin_cho_anh")
    .select("id, created_at, nguon, noi_dung, co_nut")
    .is("da_chuyen_at", null)
    .order("created_at", { ascending: true })
    .limit(toiDa);
  if (error) throw new Error(error.message);
  return (data ?? []) as TinChoAnh[];
}

export async function danhDauDaChuyen(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const { data, error } = await db()
    .from("tin_cho_anh")
    .update({ da_chuyen_at: new Date().toISOString() })
    .in("id", ids)
    .is("da_chuyen_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ?? 0;
}
