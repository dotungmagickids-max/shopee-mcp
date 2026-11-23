import { vnDate } from "@/lib/autopilot/time";
import { loadTargetsView } from "@/lib/facebook/targets-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const vnd = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString("vi-VN"));
const tr = (n: number | null | undefined) => (n == null ? "–" : `${(n / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}tr`);
const pct = (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");

export default async function TargetsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const today = vnDate();
  const v = await loadTargetsView(today);
  const { plan: p, targets: t } = v;
  const monthPct = p.month.target ? Math.min(100, Math.round((p.month.spent / p.month.target) * 100)) : null;
  const over = (x: number | null) => x != null && x < 0;
  const ratioCls = (r: number | null) => (r == null ? "" : r <= t.ratio ? "good" : "bad");

  return (
    <>
      <div className="card">
        <h1>Mục tiêu quảng cáo Facebook</h1>
        <p className="sub">
          Tháng {today.slice(5, 7)}/{today.slice(0, 4)} · hôm nay {dm(today)} · Chi thật = chi Meta × 1,111 · Doanh thu: đơn Pancake gắn quảng cáo (theo ad_id), bỏ đơn
          hủy · Đã bỏ BOSS TUYỀN 3/4/5/6 · Trang này chỉ đọc số, không bật tắt hay đổi ngân sách.
        </p>
        {msg ? <p className="warnbox">{msg}</p> : null}
        {v.missingTable ? <p className="error">Chưa có bảng fb_targets (cần áp migration 0037): đang dùng mặc định, chưa lưu được mục tiêu.</p> : null}
        {v.errors.length ? <p className="error">Thiếu số, tổng có thể thấp hơn thật: {v.errors.join("; ").slice(0, 500)}</p> : null}
      </div>

      <div className="goalcards">
        <div className="goalcard">
          <span className="gc-name">Hôm nay dự chi</span>
          <span className="gc-num">{p.today.planned == null ? "?" : vnd(p.today.planned)}đ</span>
          <span className="gc-sub">
            {p.today.planned == null
              ? "Chưa đọc được ngân sách đang bật từ Meta"
              : `Tổng ngân sách ngày của quảng cáo đang bật: ${vnd(p.today.plannedMeta)}đ trên Meta. Đã chi tới giờ: ${vnd(p.today.spentSoFar)}đ.`}
          </span>
        </div>
        <div className="goalcard">
          <span className="gc-name">Mục tiêu ngày</span>
          <span className="gc-num">{p.today.target == null ? "chưa đặt" : `${vnd(p.today.target)}đ`}</span>
          <span className="gc-sub">
            {p.today.targetFrom === "day" ? "Anh đặt riêng cho mỗi ngày." : p.today.targetFrom === "month" ? `Chia đều phần còn lại của mục tiêu tháng cho ${p.month.daysLeft} ngày còn lại.` : "Nhập mục tiêu tháng hoặc ngày ở khung bên dưới."}
          </span>
        </div>
        <div className={`goalcard ${p.today.gap == null ? "" : p.today.gap > 0 ? "warn" : "good"}`}>
          <span className="gc-name">Còn phải lên thêm</span>
          <span className="gc-num">{p.today.adsNeeded == null ? "–" : `${p.today.adsNeeded} quảng cáo`}</span>
          <span className="gc-sub">
            {p.today.gap == null
              ? "Cần có mục tiêu ngày và số dự chi."
              : p.today.gap > 0
                ? `Còn thiếu ${vnd(p.today.gap)}đ so với mục tiêu ngày. Mỗi quảng cáo mới ${vnd(t.ad_budget)}đ/ngày trên Meta.`
                : `Đang dự chi vượt mục tiêu ngày ${vnd(-p.today.gap)}đ: không cần lên thêm.`}
          </span>
        </div>
        <div className="goalcard">
          <span className="gc-name">Doanh thu hôm nay cần có</span>
          <span className="gc-num">{p.today.revenueNeeded == null ? "–" : `${vnd(p.today.revenueNeeded)}đ`}</span>
          <span className="gc-sub">Để mức dự chi hôm nay đạt tỉ lệ quảng cáo/doanh thu {pct(t.ratio)}.</span>
        </div>
      </div>

      <div className="card">
        <h2>Tháng này so với mục tiêu</h2>
        <div className="goalrow">
          <div>
            <div className="sub">Đã chi thật</div>
            <div className="big">
              {tr(p.month.spent)} {p.month.target ? <span className="sub">/ {tr(p.month.target)}{monthPct != null ? ` (${monthPct}%)` : ""}</span> : null}
            </div>
            {monthPct != null ? (
              <div className="bar">
                <span className={over(p.month.left) ? "bad" : ""} style={{ width: `${monthPct}%` }} />
              </div>
            ) : null}
            <div className="sub">
              {p.month.left == null
                ? "Chưa đặt mục tiêu tháng."
                : over(p.month.left)
                  ? `Đã vượt mục tiêu tháng ${vnd(-p.month.left)}đ.`
                  : `Còn ${vnd(p.month.left)}đ cho ${p.month.daysLeft} ngày, tức khoảng ${vnd(p.month.needPerDay)}đ mỗi ngày.`}
            </div>
            {p.month.forecast != null && p.month.target ? (
              <div className="sub">
                Giữ mức dự chi hôm nay tới hết tháng thì cả tháng chi khoảng {tr(p.month.forecast)}
                {p.month.forecast > p.month.target ? `, vượt mục tiêu ${tr(p.month.forecast - p.month.target)}.` : `, thấp hơn mục tiêu ${tr(p.month.target - p.month.forecast)}.`}
              </div>
            ) : null}
          </div>
          <div>
            <div className="sub">Doanh thu gắn quảng cáo</div>
            <div className="big">{tr(p.month.revenue)}</div>
            <div className="sub">{p.month.orders.toLocaleString("vi-VN")} đơn</div>
          </div>
          <div>
            <div className="sub">Quảng cáo / doanh thu (mục tiêu {pct(t.ratio)})</div>
            <div className={`big ${ratioCls(p.month.ratio)}`}>{pct(p.month.ratio)}</div>
            <div className="sub">
              {p.ratioOk == null ? "Chưa có doanh thu để tính." : p.ratioOk ? "Đang đạt mục tiêu." : "Đang vượt mục tiêu."}
              {p.yesterday ? ` Hôm qua (${dm(p.yesterday.ngay)}): ${pct(p.yesterday.ratio)}, chi ${vnd(p.yesterday.spent)}đ, doanh thu ${vnd(p.yesterday.revenue)}đ.` : " Hôm qua chưa có số."}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Đặt mục tiêu</h2>
        <form method="post" action="/api/fb/targets" className="filters">
          <label className="named">
            <span className="sub">Chi thật cả tháng (vd 60tr)</span>
            <input name="month_budget" defaultValue={t.month_budget ? String(t.month_budget) : ""} placeholder="để trống = chưa đặt" size={18} inputMode="text" />
          </label>
          <label className="named">
            <span className="sub">Chi thật mỗi ngày (vd 2tr)</span>
            <input name="day_budget" defaultValue={t.day_budget ? String(t.day_budget) : ""} placeholder="để trống = chia từ tháng" size={18} inputMode="text" />
          </label>
          <label className="named">
            <span className="sub">Quảng cáo / doanh thu (%)</span>
            <input name="ratio" defaultValue={String(Math.round(t.ratio * 1000) / 10)} size={8} inputMode="decimal" required />
          </label>
          <label className="named">
            <span className="sub">Ngân sách mỗi quảng cáo mới (Meta, đ/ngày)</span>
            <input name="ad_budget" defaultValue={String(t.ad_budget)} size={12} inputMode="numeric" required />
          </label>
          <button type="submit">Lưu mục tiêu</button>
        </form>
        <p className="sub" style={{ marginTop: 6 }}>
          Mục tiêu tháng và ngày là chi thật (đã nhân 1,111). Chỉ lưu con số để so sánh; không đổi ngân sách nào trên Meta.
          {v.updated_at ? ` Lưu lần cuối: ${new Date(v.updated_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}.` : ""}
        </p>
      </div>

      {v.active?.byAccount.length ? (
        <div className="card">
          <h2>Ngân sách đang bật theo tài khoản</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="l">Tài khoản</th>
                  <th>Nhóm đang chạy</th>
                  <th>Ngân sách/ngày (Meta)</th>
                  <th>Chi thật/ngày</th>
                </tr>
              </thead>
              <tbody>
                {v.active.byAccount.map((a) => (
                  <tr key={a.id}>
                    <td className="l">{a.name}</td>
                    <td>{a.adsets}{a.skipped ? ` (${a.skipped} nhóm không có ngân sách ngày)` : ""}</td>
                    <td>{vnd(a.metaDaily)}</td>
                    <td>{vnd(a.metaDaily * 1.111)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <p className="sub">{v.active ? "Hiện không có nhóm quảng cáo nào đang chạy." : "Chưa đọc được ngân sách đang bật từ Meta."}</p>
        </div>
      )}

      <div className="card">
        <h2>Từng ngày trong tháng</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="l">Ngày</th>
                <th>Chi thật</th>
                <th>So mục tiêu ngày</th>
                <th>Đơn</th>
                <th>Doanh thu</th>
                <th>QC / doanh thu</th>
              </tr>
            </thead>
            <tbody>
              {[...v.days].reverse().map((d) => {
                const r = d.revenue > 0 ? d.spendReal / d.revenue : null;
                const diff = p.today.target == null ? null : d.spendReal - p.today.target;
                return (
                  <tr key={d.ngay}>
                    <td className="l">{dm(d.ngay)}{d.ngay === today ? " (đang chạy)" : ""}</td>
                    <td>{vnd(d.spendReal)}</td>
                    <td>{diff == null ? "–" : `${diff >= 0 ? "+" : "−"}${vnd(Math.abs(diff))}`}</td>
                    <td>{d.orders}</td>
                    <td>{vnd(d.revenue)}</td>
                    <td className={ratioCls(r)}>{pct(r)}</td>
                  </tr>
                );
              })}
              {v.days.length === 0 ? (
                <tr>
                  <td className="l" colSpan={6}>Tháng này chưa có số quảng cáo nào.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
