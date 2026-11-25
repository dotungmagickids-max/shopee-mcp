import { vnDate } from "@/lib/autopilot/time";
import {
  DOW, FORMATS, GAP_ORDER, GAP_RULES, GAP_TEXT, isOpen, matchPosted, OTHER_PLACES, placeLabel, shiftDay, STATUSES, weekStart,
  type Gap, type PlanItem,
} from "@/lib/facebook/content-plan";
import { loadGaps, loadPlan, loadPlanItem, loadPostedSince, type GapData } from "@/lib/facebook/content-plan-data";
import { PAGES } from "@/lib/facebook/magic-data";
import { LABEL_TEXT, type SuggestPost } from "@/lib/facebook/suggest-run";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SP = { tab?: string; tuan?: string; sua?: string; msg?: string; ngay?: string };

const WEEKS = 2;
const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const isDay = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

function Hidden({ tab, tuan }: { tab: string; tuan: string }) {
  return (
    <>
      <input type="hidden" name="tab" value={tab} />
      <input type="hidden" name="tuan" value={tuan} />
    </>
  );
}

function ItemCard({ it, posted, tuan }: { it: PlanItem; posted: SuggestPost | null; tuan: string }) {
  const link = it.link || posted?.permalink || "";
  return (
    <div className={`calitem st-${it.trang_thai} ch-${it.kenh}`}>
      <div className="calrow">
        <span className={`chtag ch-${it.kenh}`}>{placeLabel(it.kenh, it.noi_dang, PAGES)}</span>
        <span className="sub">{FORMATS[it.dang]}</span>
      </div>
      <b>{it.ma.length ? it.ma.join(", ") : it.tieu_de || "(chưa ghi)"}</b>
      {it.ma.length && it.tieu_de ? <span className="caltitle" title={it.tieu_de}>{it.tieu_de}</span> : null}
      <div className="calrow">
        <span className="sub">{STATUSES[it.trang_thai]}{it.nguoi ? ` · ${it.nguoi}` : ""}</span>
        <a href={`/fb/content?tuan=${tuan}&sua=${it.id}#form`}>Sửa</a>
      </div>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="sub">
          {it.trang_thai === "da_dang" ? "Bài đã đăng ↗" : posted ? `Thấy bài đăng ${dm(posted.day)} ↗` : "Link ↗"}
        </a>
      ) : null}
    </div>
  );
}

function PlanForm({ edit, tuan, defaultDay }: { edit: PlanItem | null; tuan: string; defaultDay: string }) {
  const noi = edit ? `${edit.kenh}|${edit.noi_dang}` : `facebook|${Object.keys(PAGES)[0]}`;
  return (
    <div className="card" id="form">
      <div className="sechead">
        <h2 style={{ margin: 0 }}>{edit ? `Sửa dòng lịch số ${edit.id}` : "Thêm vào lịch"}</h2>
        {edit ? <a className="btnlink" href={`/fb/content?tuan=${tuan}#form`}>Thôi sửa, thêm dòng mới</a> : null}
      </div>
      <form method="post" action="/api/fb/content-plan" className="planform">
        <Hidden tab="lich" tuan={tuan} />
        {edit ? <input type="hidden" name="id" value={edit.id} /> : null}
        <input type="hidden" name="nguon" value={edit?.nguon ?? "tay"} />
        <input type="hidden" name="ly_do" value={edit?.ly_do ?? ""} />
        <label>
          Ngày đăng (để trống = chưa xếp ngày)
          <input type="date" name="ngay" defaultValue={edit ? edit.ngay ?? "" : defaultDay} />
        </label>
        <label>
          Kênh và nơi đăng
          <select name="noi" defaultValue={noi}>
            <optgroup label="Facebook">
              {Object.entries(PAGES).map(([id, name]) => (
                <option key={id} value={`facebook|${id}`}>{name}</option>
              ))}
            </optgroup>
            <optgroup label="Kênh khác">
              {OTHER_PLACES.map((p) => (
                <option key={`${p.kenh}|${p.noi}`} value={`${p.kenh}|${p.noi}`}>{p.noi}</option>
              ))}
            </optgroup>
          </select>
        </label>
        <label>
          Dạng bài
          <select name="dang" defaultValue={edit?.dang ?? "anh"}>
            {Object.entries(FORMATS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Mã sản phẩm (cách nhau dấu phẩy)
          <input name="ma" defaultValue={edit?.ma.join(", ") ?? ""} placeholder="BD26011, ADT25003" />
        </label>
        <label className="wide">
          Ý tưởng, góc bài
          <input name="tieu_de" defaultValue={edit?.tieu_de ?? ""} maxLength={200} placeholder="vd: ảnh phối đồ đi học, 4 màu" />
        </label>
        <label>
          Người làm
          <input name="nguoi" defaultValue={edit?.nguoi ?? ""} maxLength={50} placeholder="Hường" />
        </label>
        <label>
          Trạng thái
          <select name="trang_thai" defaultValue={edit?.trang_thai ?? "can_lam"}>
            {Object.entries(STATUSES).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="wide">
          Link bài đã đăng (nếu có)
          <input name="link" defaultValue={edit?.link ?? ""} maxLength={500} placeholder="https://…" />
        </label>
        <label className="wide">
          Ghi chú
          <input name="ghi_chu" defaultValue={edit?.ghi_chu ?? ""} maxLength={1000} />
        </label>
        <button type="submit">{edit ? "Lưu sửa" : "Thêm vào lịch"}</button>
      </form>
      {edit?.ly_do ? <p className="sub">Lý do đề xuất: {edit.ly_do}</p> : null}
      {edit ? (
        <div className="sgbtns">
          {edit.task_id ? (
            <span className="sub">Đã giao việc số {edit.task_id} trên bảng việc chung.</span>
          ) : (
            <form method="post" action="/api/fb/content-plan" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Hidden tab="lich" tuan={tuan} />
              <input type="hidden" name="assign" value={edit.id} />
              <input name="nguoi" defaultValue={edit.nguoi || "Hường"} maxLength={50} style={{ width: 120 }} aria-label="Giao cho" />
              <button type="submit" className="secondary">Giao việc (báo Telegram)</button>
              <span className="sub">Lưu sửa trước rồi mới giao: việc lấy nội dung đã lưu.</span>
            </form>
          )}
          <form method="post" action="/api/fb/content-plan">
            <Hidden tab="lich" tuan={tuan} />
            <input type="hidden" name="delete" value={edit.id} />
            <button type="submit" className="secondary">Xóa dòng này</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function GapTable({ data, tuan }: { data: GapData; tuan: string }) {
  if (!data.gaps.length) return <p className="sub">Không thấy mã nào thiếu content theo các luật hiện tại.</p>;
  return (
    <>
      {GAP_ORDER.map((flag) => {
        const list = data.gaps.filter((g) => g.flag === flag);
        if (!list.length) return null;
        return (
          <div className="card" key={flag}>
            <h2 style={{ marginTop: 0 }}>{GAP_TEXT[flag]} ({list.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Nhãn chạy</th>
                  <th>Lý do</th>
                  <th>Gợi ý làm</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((g: Gap) => (
                  <tr key={`${g.flag}-${g.code}`}>
                    <td><b>{g.code}</b></td>
                    <td>{g.label ? <span className={`lab lab-${g.label}`}>{LABEL_TEXT[g.label]}</span> : <span className="sub">chưa chạy</span>}</td>
                    <td>{g.reason}</td>
                    <td>{FORMATS[g.dang]}{g.page_id ? ` · ${PAGES[g.page_id] ?? ""}` : ""}</td>
                    <td>
                      {g.plannedId ? (
                        <a href={`/fb/content?sua=${g.plannedId}#form`}>Đã có trong lịch</a>
                      ) : (
                        <form method="post" action="/api/fb/content-plan">
                          <Hidden tab="thieu" tuan={tuan} />
                          <input type="hidden" name="noi" value={`facebook|${g.page_id ?? Object.keys(PAGES)[0]}`} />
                          <input type="hidden" name="dang" value={g.dang} />
                          <input type="hidden" name="ma" value={g.code} />
                          <input type="hidden" name="ly_do" value={`${GAP_TEXT[g.flag]}: ${g.reason}`} />
                          <input type="hidden" name="trang_thai" value="de_xuat" />
                          <input type="hidden" name="nguon" value="de_xuat" />
                          <button type="submit" className="secondary">Đưa vào lịch</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

export default async function ContentPlanPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const today = vnDate();
  const tab = sp.tab === "thieu" ? "thieu" : "lich";
  const start = weekStart(isDay(sp.tuan) ? sp.tuan : today);
  const end = shiftDay(start, WEEKS * 7 - 1);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => shiftDay(start, i));

  let plan: Awaited<ReturnType<typeof loadPlan>> | null = null;
  let gaps: GapData | null = null;
  let edit: PlanItem | null = null;
  let posted: SuggestPost[] = [];
  let error: string | null = null;
  try {
    if (tab === "thieu") gaps = await loadGaps(today);
    else {
      const editId = Number(sp.sua);
      [plan, edit] = await Promise.all([loadPlan(start, end), Number.isInteger(editId) && editId > 0 ? loadPlanItem(editId) : Promise.resolve(null)]);
      const waiting = [...plan.dated, ...plan.undated].filter((x) => x.kenh === "facebook" && x.ma.length && isOpen(x.trang_thai) && !x.link);
      if (waiting.length) {
        const since = waiting.map((x) => x.created_at.slice(0, 10)).sort()[0];
        posted = await loadPostedSince([...new Set(waiting.map((x) => x.noi_dang))].filter((id) => PAGES[id]), since, today);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const byDay = new Map<string, PlanItem[]>();
  for (const it of plan?.dated ?? []) if (it.ngay) byDay.set(it.ngay, [...(byDay.get(it.ngay) ?? []), it]);
  const openCount = (plan?.dated ?? []).filter((x) => isOpen(x.trang_thai)).length;

  return (
    <>
      <div className="card">
        <h1>Lịch content</h1>
        <div className="filters">
          <a href={`/fb/content?tuan=${start}`} className={tab === "lich" ? "on" : ""}>Lịch</a>
          <a href={`/fb/content?tab=thieu&tuan=${start}`} className={tab === "thieu" ? "on" : ""}>Thiếu content gì</a>
          {tab === "lich" ? (
            <>
              <span className="spacer" />
              <a href={`/fb/content?tuan=${shiftDay(start, -7)}`}>← Tuần trước</a>
              <a href={`/fb/content?tuan=${weekStart(today)}`} className={start === weekStart(today) ? "on" : ""}>Tuần này</a>
              <a href={`/fb/content?tuan=${shiftDay(start, 7)}`}>Tuần sau →</a>
            </>
          ) : null}
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          {tab === "lich"
            ? `Lịch ${WEEKS} tuần, ${dm(start)} → ${dm(end)}: ${openCount} bài còn phải làm. Dùng chung cho Facebook, Shopee, TikTok. Bài Facebook đã đăng đúng page, đúng mã, đúng dạng thì lịch tự hiện "Thấy bài đăng"; trạng thái do anh đổi. Trang chỉ ghi vào bảng lịch của mình, không đăng bài và không ghi gì lên Meta, Pancake, Shopee.`
            : `So bài đã đăng (60 ngày) với nhãn ở màn Đề xuất chạy${gaps ? ` (số ${dm(gaps.since)} → ${dm(gaps.until)})` : ""}. Thiếu ảnh / thiếu video: mã nên chạy mà ${GAP_RULES.kindDays} ngày qua không có bài dạng đó. Chưa có bài: mã tồn từ ${GAP_RULES.noPostMinStock} trở lên mà không thấy bài nào, lấy ${GAP_RULES.noPostMax} mã tồn nhiều nhất. Bấm "Đưa vào lịch" để tạo dòng Đề xuất, chưa xếp ngày, chưa giao ai.`}
        </p>
        {sp.msg ? <p className="warnbox">{sp.msg}</p> : null}
        {error ? <p className="error">Không tải được: {error}</p> : null}
        {gaps?.notes.length ? <p className="error">{gaps.notes.join("; ").slice(0, 400)}</p> : null}
      </div>

      {gaps ? <GapTable data={gaps} tuan={start} /> : null}

      {plan ? (
        <>
          <div className="calgrid">
            {DOW.map((d) => (
              <div key={d} className="calhead">{d}</div>
            ))}
            {days.map((d) => (
              <div key={d} className={`calcell${d === today ? " today" : ""}${d < today ? " past" : ""}`}>
                <div className="calrow">
                  <b>{dm(d)}</b>
                  <a href={`/fb/content?tuan=${start}&ngay=${d}#form`} title="Thêm bài vào ngày này">+</a>
                </div>
                {(byDay.get(d) ?? []).map((it) => (
                  <ItemCard key={it.id} it={it} posted={matchPosted(it, posted)} tuan={start} />
                ))}
              </div>
            ))}
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Chưa xếp ngày ({plan.undated.length})</h2>
            {plan.undated.length ? (
              <div className="calloose">
                {plan.undated.map((it) => (
                  <ItemCard key={it.id} it={it} posted={matchPosted(it, posted)} tuan={start} />
                ))}
              </div>
            ) : (
              <p className="sub">
                Chưa có dòng nào. Vào tab <a href={`/fb/content?tab=thieu&tuan=${start}`}>Thiếu content gì</a> để lấy đề xuất, hoặc thêm tay ở form bên dưới.
              </p>
            )}
          </div>

          <PlanForm edit={edit} tuan={start} defaultDay={isDay(sp.ngay) ? sp.ngay : ""} />
        </>
      ) : null}
    </>
  );
}
