import { vnDate } from "@/lib/autopilot/time";
import { contentRange, MAX_RANGE_DAYS, RANGE_PRESETS } from "@/lib/facebook/content";
import { loadContent } from "@/lib/facebook/content-data";
import Board from "./board";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SP = { r?: string; since?: string; until?: string; code?: string; page?: string };

export default async function ContentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const today = vnDate();
  const { since, until, preset } = contentRange(sp, today);
  const data = await loadContent(since, until, today);
  const fmt = (d: string) => d.split("-").reverse().join("/");
  const keep = (k: "code" | "page") => (sp[k] ? `&${k}=${encodeURIComponent(sp[k]!)}` : "");

  return (
    <>
      <div className="card">
        <h1>Bài đã đăng</h1>
        <div className="filters">
          {RANGE_PRESETS.map((n) => (
            <a key={n} href={`/fb/noi-dung?r=${n}${keep("code")}${keep("page")}`} className={preset === String(n) ? "on" : ""}>
              {n} ngày
            </a>
          ))}
          <form method="get" action="/fb/noi-dung">
            <input type="date" name="since" defaultValue={since} max={today} />
            <span>→</span>
            <input type="date" name="until" defaultValue={until} max={today} />
            {sp.code ? <input type="hidden" name="code" value={sp.code} /> : null}
            {sp.page ? <input type="hidden" name="page" value={sp.page} /> : null}
            <button type="submit" className="secondary">Xem</button>
          </form>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          Bài và reel đã đăng từ {fmt(since)} đến {fmt(until)} (giờ Việt Nam), tối đa {MAX_RANGE_DAYS} ngày một lần xem. Mã sản phẩm đọc từ nội dung
          bài (dạng BD26011, ADT25002), thiếu thì lấy từ tên quảng cáo của bài, hoặc anh bấm nút Sửa mã để gắn tay. Nhãn Đang chạy QC nghĩa là bài có
          quảng cáo đang bật và có chi tiền trong 7 ngày gần nhất. Trang không ghi gì lên Meta hay Pancake.
        </p>
        {data.notes.length ? <p className="error">{data.notes.join("; ").slice(0, 400)}</p> : null}
      </div>
      <Board posts={data.posts} pages={data.pages} initialCode={sp.code ?? ""} initialPage={sp.page ?? ""} />
    </>
  );
}
