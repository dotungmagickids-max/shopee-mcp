import { heatmap, type HeatMetric } from "@/lib/autopilot/dashboard";
import { shops } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";

export const dynamic = "force-dynamic";

const METRICS: { key: HeatMetric; label: string; higherIsBetter: boolean }[] = [
  { key: "orders", label: "Số đơn", higherIsBetter: true },
  { key: "expense", label: "Chi phí QC", higherIsBetter: true },
  { key: "roas", label: "ROAS", higherIsBetter: true },
  { key: "cpo", label: "Chi phí mỗi đơn", higherIsBetter: false },
];
const DAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const ROW_ORDER = [1, 2, 3, 4, 5, 6, 0];

export default async function Heatmap({
  searchParams,
}: {
  searchParams: Promise<{ shop?: string; metric?: string; weeks?: string }>;
}) {
  const sp = await searchParams;
  const allShops = shops();
  const shop = allShops.find((s) => String(s.shopId) === sp.shop) ?? allShops[0];
  const metric = METRICS.find((m) => m.key === sp.metric) ?? METRICS[0];
  const weeks = [2, 4, 8].includes(Number(sp.weeks)) ? Number(sp.weeks) : 4;
  const { from, to, cells } = await heatmap(shop.shopId, weeks, metric.key);
  const values = cells.flat().filter((v) => v > 0);
  const max = Math.max(1e-9, ...values);
  const min = values.length ? Math.min(...values) : 0;
  const q = (o: Record<string, string | number>) =>
    "?" + new URLSearchParams({ shop: String(shop.shopId), metric: metric.key, weeks: String(weeks), ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) });

  const fmt = (v: number) =>
    v === 0 ? "" : metric.key === "orders" ? v.toFixed(v < 10 ? 1 : 0) : metric.key === "roas" ? v.toFixed(0) : vnd(v);
  const color = (v: number) => {
    if (v === 0) return "transparent";
    let t = max === min ? 1 : (v - min) / (max - min);
    if (!metric.higherIsBetter) t = 1 - t;
    return `rgba(238, 77, 45, ${0.1 + t * 0.85})`;
  };

  return (
    <>
      <h1>Bản đồ nhiệt giờ × thứ</h1>
      <div className="filters">
        {allShops.map((s) => (
          <a key={s.shopId} className={s.shopId === shop.shopId ? "on" : ""} href={q({ shop: s.shopId })}>{s.name}</a>
        ))}
      </div>
      <div className="filters" style={{ marginTop: 8 }}>
        {METRICS.map((m) => (
          <a key={m.key} className={m.key === metric.key ? "on" : ""} href={q({ metric: m.key })}>{m.label}</a>
        ))}
        <span className="muted">|</span>
        {[2, 4, 8].map((w) => (
          <a key={w} className={w === weeks ? "on" : ""} href={q({ weeks: w })}>{w} tuần</a>
        ))}
      </div>
      <section className="card">
        <p className="muted">
          {shop.name} ({shop.shopId}) · {from} → {to} ·{" "}
          {metric.key === "orders" || metric.key === "expense" ? "trung bình mỗi ngày" : "tổng / tổng"} ·{" "}
          {metric.higherIsBetter ? "đậm = cao" : "đậm = rẻ (tốt)"}
          {metric.key === "orders" ? " · đơn theo giờ tạo, đã bỏ đơn hủy" : " · số liệu quảng cáo Shopee"}
        </p>
        <div className="table-wrap">
          <table className="heat">
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, h) => <th key={h}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {ROW_ORDER.map((wd) => (
                <tr key={wd}>
                  <th>{DAYS[wd]}</th>
                  {cells[wd].map((v, h) => (
                    <td key={h} style={{ background: color(v) }} title={`${DAYS[wd]} ${h}h: ${fmt(v) || 0}`}>{fmt(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {values.length === 0 ? <p className="muted">Chưa đủ dữ liệu. Job hằng ngày sẽ tích lũy dần.</p> : null}
      </section>
    </>
  );
}
