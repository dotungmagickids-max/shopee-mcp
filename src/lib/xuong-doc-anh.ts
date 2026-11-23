import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * Đọc ảnh chụp phiếu của xưởng (phiếu cắt, phiếu đóng gói, phiếu đặt vải) ra bảng để người nhập SOÁT LẠI rồi mới lưu.
 * Gọi Claude qua SDK chính thức, khóa ANTHROPIC_API_KEY chỉ đọc ở máy chủ. Kết quả không tự ghi vào sổ.
 * Phần làm sạch kết quả là hàm thuần để test.
 */

export type LoaiAnh = "cat" | "giao" | "vai";
export const ANH_TOI_DA = 3_500_000; // ký tự base64, khoảng 2,6 MB ảnh
export const CHUA_BAT_DOC_ANH = "Máy chủ chưa bật phần đọc ảnh";
/** Mô hình đọc ảnh. */
export const MO_HINH = "claude-haiku-5-5";

const KIEU_ANH = ["image/jpeg", "image/png", "image/webp"] as const;
type KieuAnh = (typeof KIEU_ANH)[number];

export type AnhVao = { ok: true; loai: LoaiAnh; kieu: KieuAnh; duLieu: string } | { ok: false; error: string };

/** Kiểm thân POST `{ action: "doc_anh", loai, anh: "data:image/…;base64,…" }`. */
export function docAnhVao(body: unknown): AnhVao {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (b.loai !== "cat" && b.loai !== "giao" && b.loai !== "vai") return { ok: false, error: 'loai phải là "cat", "giao" hoặc "vai"' };
  const m = typeof b.anh === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(b.anh) : null;
  if (!m) return { ok: false, error: "Ảnh phải là JPG, PNG hoặc WEBP" };
  if (m[2].length > ANH_TOI_DA) return { ok: false, error: "Ảnh lớn quá, chụp lại hoặc thu nhỏ ảnh" };
  return { ok: true, loai: b.loai, kieu: m[1] as KieuAnh, duLieu: m[2] };
}

const Bang = z.object({
  ma_hang: z.string(),
  lo: z.string(),
  ngay: z.string(),
  sizes: z.array(z.string()),
  hang: z.array(z.object({ mau: z.string(), so: z.array(z.string()) })),
  ghi_chu: z.string(),
});
const Vai = z.object({
  doi_tac: z.string(),
  ma_hang: z.string(),
  ngay: z.string(),
  vai: z.array(z.object({ ten: z.string(), mau: z.string(), sl: z.string(), dv: z.enum(["kg", "cây", "m"]), gia: z.string(), ghi: z.string() })),
  ghi_chu: z.string(),
});

export interface BangDoc {
  ma: string;
  lo: string;
  ngay: string;
  sizes: string[];
  hang: { mau: string; o: string[] }[];
  ghiChu: string;
}
export interface VaiDoc {
  doiTac: string;
  ma: string;
  ngay: string;
  vai: { ten: string; mau: string; sl: string; dv: string; gia: string; ghi: string }[];
  ghiChu: string;
}

const gon = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const chiSo = (v: unknown) => gon(v, 12).replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "").slice(0, 7);
const ngayIso = (v: unknown) => {
  const s = gon(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : "";
};

/** Làm sạch bảng màu × size AI trả về: giới hạn kích thước, số chỉ còn chữ số, bỏ dòng trống. */
export function lamSachBang(r: z.infer<typeof Bang>): BangDoc {
  const sizes = r.sizes.map((s) => gon(s, 8)).filter(Boolean).slice(0, 10);
  const hang = r.hang
    .slice(0, 30)
    .map((h) => ({ mau: gon(h.mau, 30), o: sizes.map((_, i) => chiSo(h.so[i])) }))
    .filter((h) => h.mau || h.o.some(Boolean));
  return { ma: gon(r.ma_hang, 30).toUpperCase().replace(/\s+/g, ""), lo: gon(r.lo, 30), ngay: ngayIso(r.ngay), sizes, hang, ghiChu: gon(r.ghi_chu, 400) };
}

/** Làm sạch danh sách vải AI trả về. Số lượng giữ dấu phẩy thập phân (12,5 kg); đơn giá chỉ còn chữ số. */
export function lamSachVai(r: z.infer<typeof Vai>): VaiDoc {
  const vai = r.vai
    .slice(0, 30)
    .map((v) => ({
      ten: gon(v.ten, 80),
      mau: gon(v.mau, 40),
      sl: gon(v.sl, 12).replace(/[^\d.,]/g, ""),
      dv: v.dv,
      gia: chiSo(v.gia),
      ghi: gon(v.ghi, 120),
    }))
    .filter((v) => v.ten || v.mau || v.sl);
  return { doiTac: gon(r.doi_tac, 80), ma: gon(r.ma_hang, 30).toUpperCase().replace(/\s+/g, ""), ngay: ngayIso(r.ngay), vai, ghiChu: gon(r.ghi_chu, 400) };
}

const HE_THONG = `Bạn đọc ảnh chụp phiếu của một xưởng may quần áo trẻ em ở Việt Nam và chép lại thành bảng số liệu.
Người ở xưởng sẽ soát lại bảng bạn chép rồi mới lưu vào sổ, nên điều quan trọng nhất là chép đúng những gì nhìn thấy:
- Chỉ chép số và chữ có trên ảnh. Ô nào không đọc được, bị che hoặc không chắc thì để chuỗi rỗng "" và nói rõ ô đó trong ghi_chu; đừng đoán, đừng tự cộng hay suy ra số.
- Phiếu thường viết tay, có thể nghiêng, mờ, có dòng gạch bỏ. Dòng đã gạch bỏ thì không chép.
- Số lượng chép thành chữ số liền, không dấu chấm phân cách. Không chép dòng "Tổng" hay cột "Tổng".
- Ngày ghi theo dạng YYYY-MM-DD. Phiếu thường chỉ ghi ngày/tháng; khi thiếu năm, dùng năm của "hôm nay" được cho trong tin nhắn (nếu ngày đó sẽ rơi vào tương lai thì lùi một năm). Không có ngày thì để "".
- Mã hàng là mã như ADT26001, QD26036, BD26011 (chữ in hoa rồi số, viết liền). Lô thường là "L1", "L2", "Tái 27/10". Không thấy thì để "".
- ghi_chu viết bằng tiếng Việt, ngắn, chỉ nêu chỗ cần người soát để ý (ô không đọc được, số bị sửa, tổng trên phiếu không khớp). Không có gì thì để "".`;

const VIEC: Record<LoaiAnh, string> = {
  cat: `Đây là PHIẾU CẮT (sổ cắt): số áo quần đã cắt theo màu × size.
Chép: ma_hang, lo, ngay (ngày cắt), sizes (các size theo thứ tự cột trên phiếu, ví dụ "130","140"), và hang: mỗi màu một dòng, "so" là số cắt theo đúng thứ tự của sizes (thiếu ô thì "").`,
  giao: `Đây là PHIẾU ĐÓNG GÓI hoặc phiếu xuất kho của xưởng: số hàng xưởng đóng gói giao đi theo màu × size.
Chép: ma_hang, lo, ngay (ngày giao), sizes (các size theo thứ tự cột trên phiếu), và hang: mỗi màu một dòng, "so" là số giao theo đúng thứ tự của sizes (thiếu ô thì "").
Nếu phiếu có nhiều mã hàng, chỉ chép mã hàng đầu tiên và ghi trong ghi_chu rằng phiếu còn mã khác.`,
  vai: `Đây là PHIẾU ĐẶT VẢI hoặc hóa đơn vải: các loại vải cần đặt.
Chép: doi_tac (tên nhà cung cấp vải nếu có), ma_hang (nếu phiếu ghi vải cho mã nào), ngay (ngày lập), và vai: mỗi dòng một loại vải với ten (loại vải, chất liệu), mau, sl (số lượng, giữ dấu phẩy thập phân nếu có), dv ("kg", "cây" hoặc "m"; không ghi thì chọn "kg"), gia (đơn giá, chỉ chữ số, không có thì ""), ghi (khổ vải, định lượng… nếu có).`,
};

export type KetQuaDoc = { ok: true; loai: "cat" | "giao"; bang: BangDoc } | { ok: true; loai: "vai"; vai: VaiDoc } | { ok: false; status: number; error: string };

/** Gọi Claude đọc một ảnh phiếu. Không ghi gì vào database. */
export async function docAnhPhieu(anh: { loai: LoaiAnh; kieu: KieuAnh; duLieu: string }, homNay: string): Promise<KetQuaDoc> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return { ok: false, status: 501, error: CHUA_BAT_DOC_ANH };
  const client = new Anthropic({ timeout: 55_000, maxRetries: 0 });
  const tinNhan: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: anh.kieu, data: anh.duLieu } },
        { type: "text", text: `Hôm nay là ${homNay}.\n\n${VIEC[anh.loai]}` },
      ],
    },
  ];
  // Anh chọn 23/11: thử loại rẻ nhất trước (Claude Haiku 5.5). Mô hình này không có fallback phía máy chủ khi từ chối,
  // nên từ chối được báo thành "chưa đọc được ảnh". Đọc sai nhiều trên phiếu viết tay thì đổi MO_HINH lên loại cao hơn.
  const chung = { model: MO_HINH, max_tokens: 16000, system: HE_THONG, messages: tinNhan };
  try {
    if (anh.loai === "vai") {
      const r = await client.messages.parse({ ...chung, output_config: { effort: "high", format: zodOutputFormat(Vai) } });
      if (r.stop_reason === "refusal" || !r.parsed_output) return { ok: false, status: 422, error: "Chưa đọc được ảnh này. Chụp lại rõ hơn hoặc nhập tay." };
      return { ok: true, loai: "vai", vai: lamSachVai(r.parsed_output) };
    }
    const r = await client.messages.parse({ ...chung, output_config: { effort: "high", format: zodOutputFormat(Bang) } });
    if (r.stop_reason === "refusal" || !r.parsed_output) return { ok: false, status: 422, error: "Chưa đọc được ảnh này. Chụp lại rõ hơn hoặc nhập tay." };
    return { ok: true, loai: anh.loai, bang: lamSachBang(r.parsed_output) };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error("[xuong] đọc ảnh: khóa AI không dùng được");
      return { ok: false, status: 501, error: CHUA_BAT_DOC_ANH };
    }
    if (err instanceof Anthropic.RateLimitError) return { ok: false, status: 429, error: "Máy đọc ảnh đang bận, thử lại sau một phút" };
    if (err instanceof Anthropic.BadRequestError) {
      console.error("[xuong] đọc ảnh: yêu cầu bị từ chối:", err.message);
      return { ok: false, status: 422, error: "Chưa đọc được ảnh này. Chụp lại rõ hơn hoặc nhập tay." };
    }
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, status: 504, error: "Đọc ảnh quá lâu hoặc mất kết nối, thử lại" };
    if (err instanceof Anthropic.APIError) {
      console.error(`[xuong] đọc ảnh lỗi ${err.status}:`, err.message);
      return { ok: false, status: 502, error: "Máy đọc ảnh đang lỗi, thử lại sau hoặc nhập tay" };
    }
    throw err;
  }
}
