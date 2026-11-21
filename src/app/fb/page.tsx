import { addDays, vnDate } from "@/lib/autopilot/time";
import { evaluate, rangeOf, codesFromName, type Level } from "@/lib/facebook/magic";
import { loadRange, PAGES } from "@/lib/facebook/magic-data";
import EvalTable from "./table";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SP = { r?: string; since?: string; until?: string; level?: string; acc?: string; page?: string; code?: string };
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const PRESETS: [string, string][] = [
  ["today", "Hôm nay"],
  ["yesterday", "Hôm qua"],
  ["3", "3 ngày"],
  ["7", "7 ngày"],
  ["14", "14 ngày"],
  ["30", "30 ngày"],
];
const LEVELS: [Level, string][] = [
  ["ad", "Quảng cáo"],
  ["adset", "Nhóm"],
  ["campaign", "Chiến dịch"],
];

export default async function FbPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const today = vnDate();
  const custom = isDate(sp.since) && isDate(sp.until) && sp.since! <= sp.until!;
  const preset = custom ? "custom" : sp.r ?? "yesterday";
  const { since, until } = custom ? { since: sp.since!, until: sp.until! } : rangeOf(preset, today, addDays);
  const level: Level = sp.level === "adset" || sp.level === "campaign" ? sp.level : "ad";
  const code = (sp.code ?? "").trim().toUpperCase();

  let data: Awaited<ReturnType<typeof loadRange>>;
  try {
    data = await loadRange(since, until);
  } catch (e) {
    return (
      <div className="card">
        <h1>FB Magic Tool</h1>
        <p className="error">Không đọc được số: {e instanceof Error ? e.message : String(e)}</p>
      </div>
    );
  }

  const ads = data.ads.filter(
    (a) => (!sp.acc || a.account_id === sp.acc) && (!sp.page || a.page_id === sp.page) && (!code || codesFromName(a.ad_name).includes(code))
  );
  const rows = evaluate(ads, level, data.ceilings, (c) => data.stockDays.get(c) ?? null);
  const link = (o: Partial<SP>) => {
    const q = new URLSearchParams();
    const m = { r: custom ? undefined : preset, since: custom ? since : undefined, until: custom ? until : undefined, level, acc: sp.acc, page: sp.page, code: code || undefined, ...o };
    for (const [k, v] of Object.entries(m)) if (v) q.set(k, v);
    return `/fb?${q}`;
  };
  const fmt = (d: string) => d.split("-").reverse().join("/");

  return (
    <>
      <div className="card">
        <div className="filters">
          {PRESETS.map(([k, label]) => (
            <a key={k} href={link({ r: k, since: undefined, until: undefined })} className={preset === k ? "on" : ""}>
              {label}
            </a>
          ))}
          <form method="get" action="/fb">
            <input type="date" name="since" defaultValue={since} />
            <span>→</span>
            <input type="date" name="until" defaultValue={until} />
            <input type="hidden" name="level" value={level} />
            {sp.acc ? <input type="hidden" name="acc" value={sp.acc} /> : null}
            {sp.page ? <input type="hidden" name="page" value={sp.page} /> : null}
            {code ? <input type="hidden" name="code" value={code} /> : null}
            <button type="submit" className="secondary">Xem</button>
          </form>
        </div>
        <div className="filters" style={{ marginTop: 10 }}>
          {LEVELS.map(([k, label]) => (
            <a key={k} href={link({ level: k })} className={level === k ? "on" : ""}>
              {label}
            </a>
          ))}
          <form method="get" action="/fb">
            {custom ? (
              <>
                <input type="hidden" name="since" value={since} />
                <input type="hidden" name="until" value={until} />
              </>
            ) : (
              <input type="hidden" name="r" value={preset} />
            )}
            <input type="hidden" name="level" value={level} />
            <select name="acc" defaultValue={sp.acc ?? ""}>
              <option value="">Mọi tài khoản</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select name="page" defaultValue={sp.page ?? ""}>
              <option value="">Mọi page</option>
              {Object.entries(PAGES).map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <input name="code" placeholder="Mã SP, vd BD26011" defaultValue={code} size={16} />
            <button type="submit" className="secondary">Lọc</button>
          </form>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>
          {fmt(since)}{since !== until ? ` → ${fmt(until)}` : ""} · Chi thật = chi Meta × 1,111 · Đơn/doanh thu: Pancake shop 608127 theo ad_id, bỏ đơn
          trạng thái 6 · Màu theo <a href="/fb/tran">bảng trần</a> từng mã
        </p>
        {data.errors.length ? <p className="error">Không đọc được: {data.errors.join("; ").slice(0, 600)}</p> : null}
      </div>
      <EvalTable rows={rows} level={level} />
    </>
  );
}
