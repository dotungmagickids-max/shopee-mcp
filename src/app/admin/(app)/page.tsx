import { collectCoverage, todayOverview } from "@/lib/autopilot/dashboard";
import { shops } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";
import { vnHour } from "@/lib/autopilot/time";
import { Proposals } from "./proposals";

export const dynamic = "force-dynamic";

function Kpi({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`kpi${bad ? " bad" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

export default async function Overview({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const nowHour = vnHour();
  const [coverage, ...data] = await Promise.all([
    collectCoverage(48),
    ...shops().map(async (s) => ({ shop: s, o: await todayOverview(s.shopId) })),
  ]);

  return (
    <>
      <h1>Hôm nay</h1>
      <p className="muted">
        Số liệu quảng cáo Shopee báo (ROAS cao hơn thực tế ~25%, giờ gần nhất còn tăng do ghi nhận 7 ngày).
        Thu thập 48h qua: {coverage.missing === 0 ? <span className="ok">đủ mọi giờ</span> : <span className="error">thiếu {coverage.missing} giờ</span>}.
      </p>
      {msg ? <p className="warning">{msg}</p> : null}
      <Proposals back="/admin" />
      {data.map(({ shop, o }) => {
        const maxExp = Math.max(1, ...o.byHour.map((h) => h.expense));
        return (
          <section className="card" key={shop.shopId}>
            <h2>
              {shop.name} <span className="muted">({shop.shopId})</span>
            </h2>
            <div className="kpis">
              <Kpi label="Chi quảng cáo" value={vnd(o.expense)} />
              <Kpi label="GMV quảng cáo" value={vnd(o.gmv)} />
              <Kpi label="ROAS (Shopee)" value={o.roas ? o.roas.toFixed(1) : "-"} />
              <Kpi label="Đơn QC / chi phí mỗi đơn" value={`${o.adOrders} / ${vnd(o.costPerOrder)}`} />
              <Kpi label="Đơn toàn shop (hợp lệ)" value={String(o.orders)} />
              <Kpi label="Khách trả" value={vnd(o.revenue)} />
              <Kpi label="Số dư ví QC" value={o.balance == null ? "-" : vnd(o.balance)} bad={o.balance != null && o.balance < 1_000_000} />
            </div>
            {o.expense > 0 ? (
              <>
                <div className="bars" title="Chi phí quảng cáo theo giờ">
                  {o.byHour.map((h) => (
                    <div className="col" key={h.hour} title={`${h.hour}h: chi ${vnd(h.expense)}, GMV ${vnd(h.gmv)}, ${h.adOrders} đơn QC, ${h.orders} đơn shop`}>
                      <div className={`bar${h.hour > nowHour ? " future" : ""}`} style={{ height: `${(h.expense / maxExp) * 100}%` }} />
                    </div>
                  ))}
                </div>
                <div className="hours">{o.byHour.map((h) => <span key={h.hour}>{h.hour}</span>)}</div>
                <div className="hours roas" title="ROAS theo giờ">
                  {o.byHour.map((h) => <span key={h.hour}>{h.expense > 0 ? (h.gmv / h.expense).toFixed(0) : ""}</span>)}
                </div>
                <div className="hours" title="Đơn toàn shop theo giờ">
                  {o.byHour.map((h) => <span key={h.hour}>{h.orders || ""}</span>)}
                </div>
                <p className="muted">Cột: chi phí/giờ · dòng đậm: ROAS/giờ · dòng cuối: số đơn shop/giờ.</p>
              </>
            ) : (
              <p className="muted">Chưa có chi tiêu quảng cáo hôm nay.</p>
            )}
            <p className="muted">
              Lần thu gần nhất: {fmtTime(o.lastRun?.started_at)}{" "}
              {o.lastRun ? (o.lastRun.ok ? <span className="ok">OK</span> : <span className="error">lỗi</span>) : null}
              {o.balanceAt ? ` · ví cập nhật ${fmtTime(o.balanceAt)}` : ""}
            </p>
            {o.failures.length ? (
              <div className="warning">
                <b>Cảnh báo 24h qua:</b>
                <ul>
                  {o.failures.map((f, i) => (
                    <li key={i}>
                      {fmtTime(f.started_at)} {f.job}: <code>{String(f.error ?? "").slice(0, 200)}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        );
      })}
    </>
  );
}
