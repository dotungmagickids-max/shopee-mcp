/**
 * Quản lý chất lượng CSKH, đợt 2: AI đọc từng cuộc chat, phân loại, chấm điểm và đề xuất việc nên làm với từng khách.
 *
 * Nhà cung cấp AI đổi được bằng cấu hình, không sửa code. Hai đường:
 *   1. Claude (mặc định khi không đặt CSKH_AI_BASE_URL): gọi bằng SDK chính thức của Anthropic.
 *        ANTHROPIC_API_KEY  khóa Claude (hoặc CSKH_AI_API_KEY nếu muốn dùng khóa riêng cho phần này)
 *        CSKH_AI_MODEL      tên model Claude; không đặt thì dùng claude-opus-5-5
 *   2. Bên khác có cổng kiểu OpenAI (`/chat/completions`):
 *        CSKH_AI_BASE_URL   ví dụ https://api.deepseek.com/v1
 *        CSKH_AI_API_KEY    khóa của bên đó
 *        CSKH_AI_MODEL      tên model
 *   CSKH_AI_HUONG_DAN  (tùy chọn) hướng dẫn riêng của shop: bảng size, chính sách, điều sale phải làm
 *
 * Nội dung chat chỉ đi qua bộ nhớ: đọc từ Pancake, che SĐT, email, đường dẫn, gửi cho AI, rồi bỏ. Không lưu chữ của khách.
 * Tên khách không được gửi đi (chỉ ghi "Khách").
 */
import Anthropic from "@anthropic-ai/sdk";
import type { DongCuoc, KetQuaNgay, Tin } from "./tinh";

export interface TinCoChu extends Tin {
  chu: string;
}

const GIO = 3_600_000;
const gioPhut = (ms: number) => new Date(ms + 7 * GIO).toISOString().slice(11, 16);

/** Che SĐT, email, đường dẫn và dãy số dài (số tài khoản, mã vận đơn) trước khi gửi cho AI. */
export function cheThongTin(chu: string): string {
  return chu
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)/g, "[SĐT]")
    .replace(/\d{9,}/g, "[số]");
}

const NHAN_LOAI: Record<string, string> = { anh: "[ảnh]", sticker: "[sticker]", khac: "[đính kèm]", rong: "[tin tự động không có chữ]" };

/** Soạn một cuộc chat thành chữ cho AI đọc: tin trong ngày, kèm tối đa `truoc` tin ngay trước đó làm ngữ cảnh. */
export function soanHoiThoai(tin: TinCoChu[], d0: number, d1: number, truoc = 30, toiDa = 150): string {
  const xep = [...tin].sort((a, b) => a.luc - b.luc);
  const cu = xep.filter((t) => t.luc < d0).slice(-truoc);
  const ngay = xep.filter((t) => t.luc >= d0 && t.luc < d1).slice(0, toiDa);
  const sau = xep.filter((t) => t.luc >= d1).slice(0, 10);
  const dong = (t: TinCoChu) => {
    const ai = t.ben === "khach" ? "Khách" : t.ben === "nhan_vien" ? `NV ${t.nv ?? ""}`.trim() : "Tự động";
    const chu = t.chu ? cheThongTin(t.chu).slice(0, 500) : (NHAN_LOAI[t.loai] ?? "[đính kèm]");
    return `${gioPhut(t.luc)} ${ai}: ${chu}`;
  };
  const phan: string[] = [];
  if (cu.length) phan.push("--- Trước ngày chấm (chỉ để hiểu bối cảnh, không chấm) ---", ...cu.map(dong));
  phan.push("--- Trong ngày chấm ---", ...ngay.map(dong));
  if (sau.length) phan.push("--- Sau ngày chấm (chỉ để biết kết quả) ---", ...sau.map(dong));
  return phan.join("\n");
}

export const LOAI = ["hoi_gia_size", "chot_don", "hoi_ship", "doi_tra", "khieu_nai", "hoi_don_da_dat", "spam", "khac"] as const;
export const KET_QUA = ["da_chot", "xin_duoc_sdt", "khach_im", "ngoai_size", "het_hang", "dang_trao_doi", "da_giai_quyet", "khac"] as const;
/** Cấp độ khách tiềm năng: nóng và ấm để người chăm, lạnh để AI chăm, "khong" là không cần chăm (đã mua, spam, ngoài size). */
export const TIEM_NANG = ["nong", "am", "lanh", "khong"] as const;
export type TiemNang = (typeof TIEM_NANG)[number];
export type Loai = (typeof LOAI)[number];
export type KetQua = (typeof KET_QUA)[number];

export interface KetQuaCham {
  loai: Loai;
  ketQua: KetQua;
  /** 0–10 mỗi tiêu chí (anh Tùng chốt thang 10 ngày 23/11/2026); null khi tiêu chí không áp dụng cho cuộc này. */
  diemSize: number | null;
  diemMuaKem: number | null;
  diemChot: number | null;
  diemThaiDo: number | null;
  /** Tên gọi hoặc mã sản phẩm khách hỏi. */
  sanPham: string[];
  tiemNang: TiemNang;
  lyDoTiemNang: string;
  /** 0–10: khả năng khách mua nếu sale nhắn chăm lại; null khi không cần chăm. */
  diemTiemNang: number | null;
  /** Tin sale có thể gửi để chăm lại khách (AI soạn, sale sửa trước khi gửi). Rỗng nếu không cần. */
  tinGoiY: string;
  phanHoiXau: boolean;
  moTaXau: string;
  doDongHang: boolean;
  /** Việc sale nên làm tiếp với khách này. Rỗng nếu không cần làm gì. */
  viec: string;
  mucGap: 1 | 2 | 3;
  nhanXet: string;
}

export const HUONG_DAN = `Bạn là người kiểm tra chất lượng chăm sóc khách hàng của một shop quần áo trẻ em bán qua tin nhắn Facebook.
Bạn nhận một cuộc chat giữa Khách, nhân viên (NV) và tin Tự động. Hãy đọc hết rồi trả về MỘT đối tượng JSON, không kèm chữ nào khác.

Các trường:
- "loai": một trong ${LOAI.join(", ")}. Khách hỏi giá, mẫu, size, chất vải, xin tư vấn → hoi_gia_size. Khách nói lấy, đặt, gửi địa chỉ → chot_don. Hỏi phí ship, thời gian giao → hoi_ship. Hỏi về đơn đã đặt (bao giờ tới, đổi địa chỉ) → hoi_don_da_dat. Chê hàng, bực bội, đòi hoàn tiền, nhận sai/thiếu hàng → khieu_nai. Muốn đổi size, đổi mẫu, trả hàng → doi_tra. Tin rác, bán hàng, nhắn nhầm → spam.
- "ket_qua": một trong ${KET_QUA.join(", ")}. da_chot = khách đã đồng ý mua và cho đủ thông tin nhận hàng. xin_duoc_sdt = có số điện thoại nhưng chưa chốt. khach_im = nhân viên trả lời xong khách không nhắn lại. ngoai_size = bé quá cỡ lớn nhất shop có. het_hang = hết mẫu/màu/size khách muốn. dang_trao_doi = cuộc chat còn dang dở, đang chờ một bên.
- "diem": {"size", "mua_kem", "chot", "thai_do"}, mỗi mục là số nguyên từ 0 đến 10, hoặc null nếu không áp dụng (ví dụ spam, hỏi về đơn đã đặt). Mốc chấm:
  - size: 9–10 = hỏi/nhận chiều cao cân nặng rồi chốt rõ một size, có giải thích; 4–6 = đã chốt một size nhưng không giải thích, hoặc hỏi lại điều khách đã nói; 0–2 = chỉ dán câu hỏi số đo hoặc bảng size rồi dừng, chưa chốt size nào, hoặc khách cần mà không tư vấn.
  - mua_kem: 9–10 = mời thêm mẫu phù hợp một cách tự nhiên (nêu lợi ích, ví dụ đủ mức miễn ship); 4–6 = có nhắc qua loa; 0–2 = không mời.
  - chot: 9–10 = chủ động hỏi chốt, xin thông tin nhận hàng, nhắc lại khi khách im; 4–6 = chỉ chốt khi khách tự nói lấy; 0–2 = không hỏi chốt.
  - thai_do: 9–10 = thân thiện, trả lời đúng câu khách hỏi, gọn; 4–6 = lịch sự nhưng máy móc, dán mẫu không khớp câu hỏi; 0–2 = cộc lốc, bỏ câu hỏi của khách, sai thông tin.
  Dùng các điểm ở giữa (3, 7, 8) khi cuộc chat nằm giữa hai mốc.
  Chỉ chấm việc nhân viên làm trong ngày chấm. Tin Tự động không tính là công của nhân viên.
- "san_pham": mảng tối đa 5 tên gọi hoặc mã sản phẩm khách hỏi (viết thường, ngắn, ví dụ "quần kaki", "set nỉ"). Mảng rỗng nếu không rõ.
- "tiem_nang": mức độ khách có thể mua, một trong ${TIEM_NANG.join(", ")}.
  - nong: sắp mua. Khách đã chọn mẫu/màu/size, hỏi cách đặt, cho số điện thoại hay địa chỉ, hoặc nói sẽ lấy nhưng chưa xong đơn.
  - am: quan tâm thật nhưng chưa quyết. Khách đã cho số đo của bé, hoặc hỏi cụ thể về một mẫu (giá, size, màu, chất vải, xin ảnh thật), có trả lời qua lại rồi dừng.
  - lanh: gần như chưa tương tác. Khách chỉ bấm quảng cáo, chỉ gửi một câu chung chung ("tư vấn", "ib", "giá", dấu chấm) hoặc im ngay sau tin đầu, chưa cho số đo và chưa nói mẫu nào.
  - khong: không cần chăm để bán. Đã chốt xong đơn (kể cả khi vừa chốt trong ngày), spam, ngoài size, chỉ hỏi về đơn đã đặt, hoặc đang khiếu nại.
  "diem_tiem_nang": số nguyên 0–10, khả năng khách này mua nếu sale nhắn chăm lại đúng cách (10 = gần như chắc chắn; 7–9 = đã chọn mẫu hoặc size; 4–6 = quan tâm cụ thể; 1–3 = mới bấm quảng cáo). null nếu "tiem_nang" là khong.
  "tin_goi_y": một tin nhắn ngắn (tối đa 300 ký tự) sale có thể gửi để chăm lại khách này, xưng "em", gọi khách là "chị", nhắc đúng mẫu/size khách đã hỏi và kết bằng một câu hỏi dễ trả lời. Không bịa giá, tồn kho hay ưu đãi không có trong cuộc chat. Chuỗi rỗng nếu "tiem_nang" là khong.
  "ly_do_tiem_nang": một câu ngắn nêu dấu hiệu khiến bạn xếp mức đó, tối đa 150 ký tự.
- "phan_hoi_xau": true nếu khách phàn nàn, chê, bực, dọa trả hàng hay báo nhận sai/thiếu/lỗi. "mo_ta_xau": một câu nói rõ khách phàn nàn điều gì (rỗng nếu không có). "do_dong_hang": true nếu lỗi do đóng gói, giao sai, thiếu hàng.
- "viec": MỘT việc cụ thể sale nên làm tiếp với khách này, viết như lời giao việc, tối đa 200 ký tự (ví dụ "Nhắn lại hỏi chị chọn màu nào để giữ size 150 quần kaki, nhắc mức miễn ship"). Chuỗi rỗng nếu không cần làm gì thêm (đã chốt xong, spam, khách ngoài size đã được báo rõ).
- "muc_gap": 1 = cần làm ngay (khách đang chờ trả lời, khiếu nại, sắp chốt); 2 = trong ngày; 3 = khi rảnh.
- "nhan_xet": một câu nhận xét cách nhân viên xử lý, tối đa 200 ký tự.

Tuyệt đối không ghi tên người, số điện thoại, địa chỉ vào bất kỳ trường nào. Viết tiếng Việt.`;

const cat = (x: unknown, n: number) => cheThongTin(String(x ?? "").replace(/\s+/g, " ").trim()).slice(0, n);
const diem = (x: unknown): number | null => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Math.max(0, Math.min(10, Math.round(Number(x)))));

/** Đọc câu trả lời của AI: lấy khối JSON, chỉ nhận giá trị hợp lệ, cắt độ dài, che lại SĐT nếu AI lỡ chép. */
export function docKetQua(text: string): KetQuaCham | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o: any;
  try {
    o = JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const loai = (LOAI as readonly string[]).includes(o.loai) ? (o.loai as Loai) : "khac";
  const ketQua = (KET_QUA as readonly string[]).includes(o.ket_qua) ? (o.ket_qua as KetQua) : "khac";
  const d = o.diem ?? {};
  const gap = Number(o.muc_gap);
  return {
    loai,
    ketQua,
    diemSize: diem(d.size),
    diemMuaKem: diem(d.mua_kem),
    diemChot: diem(d.chot),
    diemThaiDo: diem(d.thai_do),
    sanPham: [...new Set((Array.isArray(o.san_pham) ? o.san_pham : []).map((x: unknown) => cat(x, 40).toLowerCase()).filter(Boolean))].slice(0, 5) as string[],
    tiemNang: (TIEM_NANG as readonly string[]).includes(o.tiem_nang) ? (o.tiem_nang as TiemNang) : "khong",
    lyDoTiemNang: cat(o.ly_do_tiem_nang, 200),
    diemTiemNang: (TIEM_NANG as readonly string[]).includes(o.tiem_nang) && o.tiem_nang !== "khong" ? diem(o.diem_tiem_nang) : null,
    tinGoiY: (TIEM_NANG as readonly string[]).includes(o.tiem_nang) && o.tiem_nang !== "khong" ? cat(o.tin_goi_y, 400) : "",
    phanHoiXau: o.phan_hoi_xau === true,
    moTaXau: o.phan_hoi_xau === true ? cat(o.mo_ta_xau, 300) : "",
    doDongHang: o.phan_hoi_xau === true && o.do_dong_hang === true,
    viec: cat(o.viec, 300),
    mucGap: gap === 1 || gap === 3 ? gap : 2,
    nhanXet: cat(o.nhan_xet, 300),
  };
}

export interface CauHinhAi {
  /** "claude" = SDK Anthropic; "openai" = bên khác có cổng kiểu OpenAI. */
  ben: "claude" | "openai";
  baseUrl: string;
  khoa: string;
  model: string;
  huongDanRieng: string;
}

export const MODEL_CLAUDE_MAC_DINH = "claude-opus-5-5";

export function cauHinhAi(model?: string): CauHinhAi | null {
  const baseUrl = process.env.CSKH_AI_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const huongDanRieng = process.env.CSKH_AI_HUONG_DAN?.trim() ?? "";
  const m = (model || process.env.CSKH_AI_MODEL || "").trim();
  if (!baseUrl) {
    const khoa = process.env.CSKH_AI_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
    return khoa ? { ben: "claude", baseUrl: "", khoa, model: m || MODEL_CLAUDE_MAC_DINH, huongDanRieng } : null;
  }
  const khoa = process.env.CSKH_AI_API_KEY?.trim();
  if (!khoa || !m || !/^https:\/\//.test(baseUrl)) return null;
  return { ben: "openai", baseUrl, khoa, model: m, huongDanRieng };
}

export interface LuotCham {
  kq: KetQuaCham | null;
  tokenVao: number;
  tokenRa: number;
}

/** Gửi một cuộc chat đã soạn cho AI. Lỗi mạng hoặc lỗi của bên AI thì ném lỗi (không kèm khóa). */
export async function chamMot(hoiThoai: string, c: CauHinhAi): Promise<LuotCham> {
  const he = c.huongDanRieng ? `${HUONG_DAN}\n\nHướng dẫn riêng của shop:\n${c.huongDanRieng}` : HUONG_DAN;
  if (c.ben === "claude") return chamBangClaude(he, hoiThoai, c);
  const than = (jsonMode: boolean) =>
    JSON.stringify({
      model: c.model,
      temperature: 0,
      max_tokens: 800,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: he },
        { role: "user", content: `Cuộc chat cần chấm:\n\n${hoiThoai}` },
      ],
    });
  const goi = (jsonMode: boolean) => fetch(`${c.baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.khoa}` }, body: than(jsonMode) });
  let res = await goi(true);
  if (res.status === 400) res = await goi(false); // có bên không nhận response_format
  if (!res.ok) throw new Error(`AI chấm điểm HTTP ${res.status}`);
  const body: any = await res.json();
  const text = String(body?.choices?.[0]?.message?.content ?? "");
  return { kq: docKetQua(text), tokenVao: Number(body?.usage?.prompt_tokens ?? 0) || 0, tokenRa: Number(body?.usage?.completion_tokens ?? 0) || 0 };
}

/** Các model Claude có tự chuyển sang model dự phòng khi bộ lọc an toàn từ chối (Haiku không có). */
const CO_DU_PHONG = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const khachClaude = new Map<string, Anthropic>();

async function chamBangClaude(he: string, hoiThoai: string, c: CauHinhAi): Promise<LuotCham> {
  let client = khachClaude.get(c.khoa);
  if (!client) khachClaude.set(c.khoa, (client = new Anthropic({ apiKey: c.khoa })));
  // Phần hướng dẫn giống nhau ở mọi cuộc nên đặt mốc lưu đệm; việc phân loại không cần suy nghĩ sâu nên để effort thấp.
  const chung = {
    model: c.model,
    max_tokens: 16000,
    output_config: { effort: "low" as const },
    system: [{ type: "text" as const, text: he, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user" as const, content: `Cuộc chat cần chấm:

${hoiThoai}` }],
  };
  try {
    const msg = CO_DU_PHONG.test(c.model) ? await client.beta.messages.create({ ...chung, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }) : await client.messages.create(chung);
    if (msg.stop_reason === "refusal") throw new Error("AI từ chối chấm cuộc này");
    let text = "";
    for (const b of msg.content) if (b.type === "text") text += b.text;
    const u = msg.usage;
    return { kq: docKetQua(text), tokenVao: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), tokenRa: u.output_tokens ?? 0 };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new Error("Claude đang giới hạn tốc độ, lượt sau chấm tiếp");
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Khóa Claude không đúng hoặc đã hết hiệu lực");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API lỗi ${err.status ?? ""}`.trim());
    throw err;
  }
}

/* ------------------------------- gộp điểm cho trang ------------------------------- */

export interface DongCham extends KetQuaCham {
  page: string;
  id: string;
}

const tb = (xs: Array<number | null>): number | null => {
  const co = xs.filter((x): x is number => x != null);
  return co.length ? Math.round((co.reduce((a, b) => a + b, 0) / co.length) * 100) / 100 : null;
};
const dem = <T,>(xs: T[], khoa: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(khoa(x), (m.get(khoa(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** Gộp điểm từng cuộc thành bảng cho trang. `canCham` = số cuộc có khách nhắn trong ngày. */
export function gopCham(k: KetQuaNgay, rows: DongCham[], model: string) {
  const cuoc = new Map<string, DongCuoc>(k.cuoc.map((c) => [`${c.page}|${c.id}`, c]));
  const co = rows.filter((r) => cuoc.has(`${r.page}|${r.id}`)).map((r) => ({ r, c: cuoc.get(`${r.page}|${r.id}`)! }));
  const theoNguoi = new Map<string, typeof co>();
  for (const x of co) theoNguoi.set(x.c.nguoi ?? "(chưa ai trả lời)", [...(theoNguoi.get(x.c.nguoi ?? "(chưa ai trả lời)") ?? []), x]);
  const dongDiem = (ten: string, xs: typeof co) => ({ ten, cuoc: xs.length, size: tb(xs.map((x) => x.r.diemSize)), muaKem: tb(xs.map((x) => x.r.diemMuaKem)), chot: tb(xs.map((x) => x.r.diemChot)), thaiDo: tb(xs.map((x) => x.r.diemThaiDo)) });
  const dong = ({ r, c }: (typeof co)[number]) => ({
    duoi: c.duoi,
    page: c.page,
    id: c.id,
    nhom: c.nhom,
    nguoi: c.nguoi,
    loai: r.loai,
    ketQua: r.ketQua,
    diem: [r.diemSize, r.diemMuaKem, r.diemChot, r.diemThaiDo],
    viec: r.viec,
    mucGap: r.mucGap,
    nhanXet: r.nhanXet,
    chot: c.chot,
    xau: r.phanHoiXau,
    moTaXau: r.moTaXau,
    doDongHang: r.doDongHang,
    // Cuộc đã có đơn POS thì không còn là khách cần chăm, dù AI xếp mức nào.
    capDo: (c.chot ? "khong" : r.tiemNang) as TiemNang,
    diemTiemNang: c.chot ? null : r.diemTiemNang,
    tinGoiY: c.chot ? "" : r.tinGoiY,
    khachCuoiLuc: c.khachCuoiLuc ?? null,
    choKhach: !!c.choKhach,
    lyDo: r.lyDoTiemNang,
    sanPham: r.sanPham,
    // Anh Tùng chốt 23/11/2026: khách lạnh để AI chăm, khách nóng và ấm để người chăm.
    aiCham: !c.chot && r.tiemNang === "lanh",
  });
  const tat = co.map(dong);
  return {
    model,
    canCham: k.cuoc.filter((c) => c.tinKhach > 0).length,
    daCham: co.length,
    loai: dem(co, (x) => x.r.loai).map(([loai, n]) => ({ loai, cuoc: n })),
    ketQua: dem(co, (x) => x.r.ketQua).map(([ketQua, n]) => ({ ketQua, cuoc: n })),
    diem: [dongDiem("Tất cả", co), ...[...theoNguoi.entries()].map(([ten, xs]) => dongDiem(ten, xs)).sort((a, b) => b.cuoc - a.cuoc)],
    sanPham: dem(co.flatMap((x) => x.r.sanPham), (s) => s).slice(0, 30).map(([ten, n]) => ({ ten, cuoc: n })),
    // Việc với từng khách: việc gấp trước; cuộc đã có đơn thì không cần nhắc chốt nữa.
    viec: tat.filter((d) => d.viec && !(d.chot && d.ketQua === "da_chot")).sort((a, b) => a.mucGap - b.mucGap || a.duoi.localeCompare(b.duoi)),
    xau: tat.filter((d) => d.xau),
    // Cần chăm lại (anh Tùng chốt 23/11/2026): sale đã trả lời, khách chưa nhắn lại, chưa có đơn, còn tiềm năng.
    // Xếp theo điểm tiềm năng cao trước, rồi khách nhắn gần đây trước.
    chamLai: tat
      .filter((d) => d.choKhach && !d.chot && (d.capDo === "nong" || d.capDo === "am"))
      .sort((a, b) => (b.diemTiemNang ?? 0) - (a.diemTiemNang ?? 0) || (b.khachCuoiLuc ?? 0) - (a.khachCuoiLuc ?? 0) || a.duoi.localeCompare(b.duoi)),
    tiemNang: TIEM_NANG.map((capDo) => ({ capDo, cuoc: tat.filter((d) => d.capDo === capDo).length })),
    // Khách tiềm năng: nóng trước, rồi ấm, rồi lạnh. Cuộc đã có đơn POS thì không còn là khách cần chăm.
    khach: tat.filter((d) => d.capDo !== "khong" && !d.chot).sort((a, b) => TIEM_NANG.indexOf(a.capDo) - TIEM_NANG.indexOf(b.capDo) || a.mucGap - b.mucGap || a.duoi.localeCompare(b.duoi)),
  };
}
