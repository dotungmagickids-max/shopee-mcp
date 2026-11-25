import { vnDate } from "@/lib/autopilot/time";
import { normCode } from "@/lib/facebook/content";
import { PAGES } from "@/lib/facebook/magic-data";
import { LABEL_ORDER, LABEL_TEXT, launchGroups, money, SUGGEST_RULES, VERDICT_LABEL, type CodeLabel, type CodeRow } from "@/lib/facebook/suggest-run";
import { loadSuggest, POST_DAYS } from "@/lib/facebook/suggest-run-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SP = { nhan?: string; ma?: string; page?: string };

const SHOULD: CodeLabel[] = ["scale", "test", "try"];
const POSTS_SHOWN = 8;
const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);
const pageShort = (id: string) => PAGES[id] ?? id;

function CodeCard({ row }: { row: CodeRow }) {
  const groups = launchGroups(row);
  const shown = row.posts.filter((p) => row.label !== "stop" || p.spendReal > 0).slice(0, POSTS_SHOWN);
  return (
    <div className="card sgcard">
      <div className="sghead">
        <h2 style={{ margin: 0 }}>{row.code}</h2>
        <span className={`lab lab-${row.label}`}>{LABEL_TEXT[row.label]}</span>
        <span className="sub">
          Chi {money(row.spendReal)} · {row.orders} đơn · {pct(row.ratio)} (trần {pct(row.ceiling.profit_ceiling)}) · {row.adsRunning} QC đang chạy ·{" "}
          {row.stock == null ? "chưa có số tồn" : `tồn ${row.stock}${row.stockDays != null ? `, ~${Math.floor(row.stockDays)} ngày bán` : ""}`}
        </span>
      </div>
      <p style={{ margin: "6px 0" }}>{row.reason}</p>
      {groups.length ? (
        <div className="sgbtns">
          {groups.map((g) => (
            <a
              key={`${g.kind}-${g.page_id}`}
              className={`btnlink${g.kind === "scale" ? " go" : ""}`}
              href={`/fb/len-camp?page=${g.page_id}&posts=${g.posts.join(",")}&shape=${g.kind === "scale" ? "1-n-1" : "1-1-n"}`}
            >
              {g.kind === "scale" ? "Lên camp scale 1-N-1" : "Lên camp test 1-1-N"} · {pageShort(g.page_id)} ({g.posts.length} bài)
            </a>
          ))}
        </div>
      ) : null}
      {shown.length ? (
        <div className="postgrid small">
          {shown.map((p) => (
            <article key={p.story_id} className="post">
              <a className="thumb" href={p.post?.permalink ?? `https://facebook.com/${p.story_id}`} target="_blank" rel="noreferrer" title="Mở bài trên Facebook">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.post?.picture ? <img src={p.post.picture} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="noimg">{p.post ? "Không có ảnh" : `Bài cũ hơn ${POST_DAYS} ngày`}</span>}
                {p.post ? <span className="day">{dm(p.post.day)}</span> : null}
                <span className={`adnote v-${p.verdict}`}>{VERDICT_LABEL[p.verdict]}</span>
              </a>
              <div className="body">
                <span className="sub">{pageShort(p.page_id)}</span>
                {p.spendReal > 0 ? (
                  <span style={{ fontSize: 13 }}>
                    Chi {money(p.spendReal)} · {p.orders} đơn · {pct(p.ratio)}
                    {p.ads ? ` · ${p.running}/${p.ads} QC bật` : ""}
                  </span>
                ) : (
                  <span className="sub">Chưa chạy trong {SUGGEST_RULES.days} ngày</span>
                )}
                <p className="msg" title={p.post?.message ?? p.adNames.join("\n")}>{p.post?.message || p.adNames[0] || "(bài không có chữ)"}</p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="sub">Không có bài nào có mã này trong {POST_DAYS} ngày gần nhất.</p>
      )}
      {row.posts.length > shown.length ? <p className="sub">Còn {row.posts.length - shown.length} bài khác của mã này.</p> : null}
    </div>
  );
}

export default async function SuggestPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const today = vnDate();
  let data: Awaited<ReturnType<typeof loadSuggest>> | null = null;
  let error: string | null = null;
  try {
    data = await loadSuggest(today);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const nhan = (LABEL_ORDER as string[]).includes(sp.nhan ?? "") ? (sp.nhan as CodeLabel) : sp.nhan === "all" ? "all" : "nen";
  const ma = normCode(sp.ma);
  const page = sp.page && PAGES[sp.page] ? sp.page : "";
  const all = (data?.rows ?? []).filter((r) => (!ma || r.code.includes(ma)) && (!page || r.posts.some((p) => p.page_id === page)));
  const list = all.filter((r) => (nhan === "all" ? true : nhan === "nen" ? SHOULD.includes(r.label) : r.label === nhan));
  const count = (l: CodeLabel) => all.filter((r) => r.label === l).length;
  const link = (n: string) => `/fb/de-xuat?nhan=${n}${ma ? `&ma=${encodeURIComponent(ma)}` : ""}${page ? `&page=${page}` : ""}`;

  return (
    <>
      <div className="card">
        <h1>Đề xuất chạy</h1>
        <p className="sub">
          Xét {SUGGEST_RULES.days} ngày{data ? ` (${dm(data.since)} → ${dm(data.until)}, chưa tính hôm nay)` : ""}: chi Meta × 1,111, đơn và doanh thu
          Pancake theo từng quảng cáo; tồn kho Pancake POS (đồng bộ đêm); trần % theo Bảng trần. Bài lấy {POST_DAYS} ngày gần nhất của các page. Trang
          chỉ đọc và gợi ý, không ghi gì lên Meta.
        </p>
        <div className="filters">
          <a href={link("nen")} className={nhan === "nen" ? "on" : ""}>Nên chạy ({SHOULD.reduce((t, l) => t + count(l), 0)})</a>
          {LABEL_ORDER.map((l) => (
            <a key={l} href={link(l)} className={nhan === l ? "on" : ""}>
              {LABEL_TEXT[l]} ({count(l)})
            </a>
          ))}
          <a href={link("all")} className={nhan === "all" ? "on" : ""}>Tất cả ({all.length})</a>
          <form method="get" action="/fb/de-xuat">
            <input type="hidden" name="nhan" value={nhan} />
            <input name="ma" defaultValue={ma} placeholder="Mã, vd BD26011" style={{ width: 150 }} />
            <select name="page" defaultValue={page}>
              <option value="">Mọi page</option>
              {Object.entries(PAGES).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <button type="submit" className="secondary">Lọc</button>
          </form>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="sub">Cách xếp nhãn</summary>
          <ul className="sub" style={{ margin: "6px 0" }}>
            <li><b>Đừng chạy</b>: hàng còn dưới {SUGGEST_RULES.minStockDays} ngày bán, hoặc chi trên {money(SUGGEST_RULES.stopSpendNoOrder)} chưa có đơn, hoặc % vượt hòa vốn của mã.</li>
            <li><b>Scale</b>: từ {SUGGEST_RULES.scaleMinOrders} đơn, % dưới trần lãi của mã, hàng còn đủ bán.</li>
            <li><b>Test thêm bài</b>: như Scale nhưng mới chạy tối đa {SUGGEST_RULES.testMaxPostsRun} bài và còn bài chưa chạy.</li>
            <li><b>Thử mã</b>: hàng còn trên {SUGGEST_RULES.tryStockDays} ngày bán (hoặc tồn mà chưa bán), {SUGGEST_RULES.days} ngày chi dưới {money(SUGGEST_RULES.tryMaxSpend)}.</li>
            <li><b>Theo dõi</b>: còn lại (ít đơn, % giữa trần lãi và hòa vốn…).</li>
            <li>Bài: <b>Bài thắng</b> (≥{SUGGEST_RULES.scaleMinOrders} đơn, dưới trần) → scale 1-N-1; <b>Từng tốt, đang tắt</b> → chạy lại; <b>Chưa chạy</b> → test 1-1-N.</li>
            <li>Mã của quảng cáo lấy theo mã của bài gốc; không đọc được bài thì lấy từ tên quảng cáo. Bài có 2 mã được tính cho cả hai.</li>
          </ul>
        </details>
        {error ? <p className="error">Không tải được: {error}</p> : null}
        {data?.pageErrors.length ? <p className="error">Chưa đọc được bài: {data.pageErrors.join("; ").slice(0, 400)}</p> : null}
        {data?.notes.length ? <p className="error">{data.notes.join("; ").slice(0, 400)}</p> : null}
      </div>
      {data && !list.length ? (
        <div className="card">
          <p className="sub">Không có mã nào khớp bộ lọc.</p>
        </div>
      ) : null}
      {list.slice(0, 60).map((r) => (
        <CodeCard key={r.code} row={r} />
      ))}
      {list.length > 60 ? <p className="sub">Còn {list.length - 60} mã nữa, anh lọc theo mã hoặc nhãn để xem.</p> : null}
    </>
  );
}
