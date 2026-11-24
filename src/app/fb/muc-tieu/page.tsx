import { vnDate } from "@/lib/autopilot/time";
import { loadTargetsView } from "@/lib/facebook/targets-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const vnd = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString("vi-VN"));
const tr = (n: number | null | undefined) => (n == null ? "–" : `${(n / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}tr`);
const pct = (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const dm = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" }) : null);
const THU = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
const wd = (d: string) => THU[new Date(`${d}T00:00:00Z`).getUTCDay()];

export default async function TargetsPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const today = vnDate();
  const v = await loadTargetsView(today);
  const { plan: p, targets: t } = v;
  const monthPct = p.month.target ? Math.min(100, Math.round((p.month.spent / p.month.target) * 100)) : null;
  const over = (x: number | null) => x != null && x < 0;
  const ratioCls = (r: number | null) => (r == null ? "" : r <= t.ratio ? "good" : "bad");
  // Thanh ngân sách hôm nay: thang đo là số lớn nhất trong dự chi và mục tiêu ngày.
  const scale = Math.max(1, p.today.planned ?? 0, p.today.target ?? 0);
  const barPct = (x: number) => Math.max(0, Math.min(100, (x / scale) * 100));

  return (
    <>
      <div className="card">
        <h1>Mục tiêu quảng cáo Facebook</h1>
        <p className="sub">
          Tháng {today.slice(5, 7)}/{today.slice(0, 4)} · hôm nay {dm(today)} · Chi thật = chi Meta × 1,111 · Doanh thu: đơn chốt kênh Facebook trên Pancake
          {p.month.revenueThrough ? ` (đã có tới ${dm(p.month.revenueThrough)}; đồng bộ mỗi sáng)` : " (chưa có ngày nào)"} · Đã bỏ BOSS TUYỀN 3/4/5/6 · Trang này chỉ đọc số, không
          bật tắt hay đổi ngân sách.
        </p>
        {msg ? <p className="warnbox">{msg}</p> : null}
        {v.missing.length ? (
          <form method="post" action="/api/fb/backfill" className="warnbox" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "8px 0" }}>
            <span>
              <b>Thiếu số chi của {v.missing.length} ngày</b> ({v.missing.map(dm).join(", ")}): số đã chi tháng này đang thấp hơn thật. Có thể do chưa thu số, hoặc ngày đó không chi.
            </span>
            <button type="submit">Thu lại số các ngày thiếu</button>
            <span className="sub">Mỗi lần bấm thu 4 ngày, mất khoảng 1–2 phút. Chỉ đọc Meta và Pancake.</span>
          </form>
        ) : null}
        {v.pancakeOk ? null : <p className="error">Chưa đọc được doanh thu Pancake: đang tạm dùng doanh thu của đơn gắn mã quảng cáo, tỉ lệ sẽ cao hơn thật.</p>}
        {v.missingTable ? <p className="error">Chưa có bảng fb_targets (cần áp migration 0037): đang dùng mặc định, chưa lưu được mục tiêu.</p> : null}
        {v.errors.length ? <p className="error">Thiếu số, tổng có thể thấp hơn thật: {v.errors.join("; ").slice(0, 500)}</p> : null}
      </div>

      <div className="card">
        <div className="sechead">
          <h2>Hôm nay {wd(today)} {dm(today)}</h2>
          <span className="sub">Đọc số lúc {hm(v.active?.readAt ?? null) ?? "–"}. Tải lại trang để cập nhật.</span>
        </div>

        <div className="budgetbar">
          <div className="bb-track">
            <span className="bb-run" style={{ width: `${barPct(p.today.running ?? 0)}%` }} title="Đang thực chạy" />
            <span className="bb-plan" style={{ width: `${barPct(p.today.drafts)}%` }} title="Kế hoạch (nháp)" />
            {p.today.target ? <span className="bb-goal" style={{ left: `${barPct(p.today.target)}%` }} title="Mục tiêu ngày" /> : null}
          </div>
          <div className="bb-legend">
            <span><i className="dot run" /> Đang chạy {vnd(p.today.running)}đ</span>
            <span><i className="dot plan" /> Kế hoạch (nháp) {vnd(p.today.drafts)}đ</span>
            <span><i className="dot goal" /> Mục tiêu ngày {p.today.target == null ? "chưa đặt" : `${vnd(p.today.target)}đ`}</span>
          </div>
        </div>

        <div className="goalcards">
          <div className="goalcard">
            <span className="gc-name">Dự chi hôm nay</span>
            <span className="gc-num">{p.today.planned == null ? "?" : `${vnd(p.today.planned)}đ`}</span>
            <span className="gc-src">
              = đang chạy + kế hoạch, chi thật (× 1,111).
              <br />
              Nguồn: ngân sách ngày của các nhóm đang chạy trên Meta lúc {hm(v.active?.readAt ?? null) ?? "–"}, cộng ngân sách các nháp ở màn Lên camp.
            </span>
          </div>
          <div className="goalcard">
            <span className="gc-name">Đã chi tới giờ</span>
            <span className="gc-num">{vnd(p.today.spentSoFar)}đ</span>
            <span className="gc-src">
              Chi thật từ 0h hôm nay.
              <br />
              Nguồn: số Meta, thu mỗi giờ 9h–23h{v.spendUpdatedAt ? `; lần cuối ${hm(v.spendUpdatedAt)}` : "; hôm nay chưa thu lần nào"}.
            </span>
          </div>
          <div className={`goalcard ${p.today.gap == null ? "" : p.today.gap > 0 ? "warn" : "good"}`}>
            <span className="gc-name">Còn phải lên thêm</span>
            <span className="gc-num">{p.today.adsNeeded == null ? "–" : `${p.today.adsNeeded} quảng cáo`}</span>
            <span className="gc-src">
              {p.today.gap == null
                ? "Cần đặt mục tiêu tháng hoặc ngày ở khung bên dưới."
                : p.today.gap > 0
                  ? `Thiếu ${vnd(p.today.gap)}đ so với mục tiêu ngày; mỗi quảng cáo mới ${vnd(t.ad_budget)}đ/ngày trên Meta.`
                  : `Dự chi đã vượt mục tiêu ngày ${vnd(-p.today.gap)}đ: không cần lên thêm.`}
              <br />
              Mục tiêu ngày: {p.today.targetFrom === "day" ? "anh đặt riêng." : p.today.targetFrom === "month" ? `chia phần còn lại của tháng cho ${p.month.daysLeft} ngày.` : "chưa đặt."}
            </span>
          </div>
          <div className="goalcard">
            <span className="gc-name">Doanh thu hôm nay cần có</span>
            <span className="gc-num">{p.today.revenueNeeded == null ? "–" : `${vnd(p.today.revenueNeeded)}đ`}</span>
            <span className="gc-src">Để dự chi hôm nay đạt tỉ lệ {pct(t.ratio)}. Doanh thu thật hôm nay chỉ có sau khi Pancake đồng bộ sáng mai.</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="sechead">
          <h2>Tháng {today.slice(5, 7)}/{today.slice(0, 4)}</h2>
          <span className="sub">Chi tính từ 01/{today.slice(5, 7)} tới hôm nay; doanh thu và tỉ lệ tính tới {p.month.revenueThrough ? dm(p.month.revenueThrough) : "–"} (ngày Pancake đã về).</span>
        </div>
        <div className="goalcards">
          <div className="goalcard">
            <span className="gc-name">Đã chi thật · 01/{today.slice(5, 7)} → {dm(today)}</span>
            <span className="gc-num">
              {tr(p.month.spent)}
              {p.month.target ? <span className="gc-of"> / {tr(p.month.target)}</span> : null}
            </span>
            {monthPct != null ? (
              <div className="bar">
                <span className={over(p.month.left) ? "bad" : ""} style={{ width: `${monthPct}%` }} />
              </div>
            ) : null}
            <span className="gc-src">
              {p.month.left == null
                ? "Chưa đặt mục tiêu tháng."
                : over(p.month.left)
                  ? `Đã vượt mục tiêu ${vnd(-p.month.left)}đ.`
                  : `Còn ${vnd(p.month.left)}đ cho ${p.month.daysLeft} ngày (khoảng ${vnd(p.month.needPerDay)}đ/ngày).`}
              {p.month.forecast != null && p.month.target ? ` Giữ mức dự chi hôm nay thì cuối tháng khoảng ${tr(p.month.forecast)}.` : ""}
              <br />
              Nguồn: số Meta đã thu mỗi ngày × 1,111{v.missing.length ? `; đang thiếu ${v.missing.length} ngày (xem khung vàng)` : ""}.
            </span>
          </div>
          <div className="goalcard">
            <span className="gc-name">Doanh thu Facebook · 01/{today.slice(5, 7)} → {p.month.revenueThrough ? dm(p.month.revenueThrough) : "–"}</span>
            <span className="gc-num">{tr(p.month.revenue)}</span>
            <span className="gc-src">
              {p.month.orders.toLocaleString("vi-VN")} đơn chốt. Trong đó đơn gắn mã quảng cáo {tr(p.month.adRevenue)}.
              <br />
              Nguồn: đơn chốt kênh Facebook trên Pancake, đồng bộ mỗi sáng.
            </span>
          </div>
          <div className={`goalcard ${p.ratioOk == null ? "" : p.ratioOk ? "good" : "warn"}`}>
            <span className="gc-name">Quảng cáo / doanh thu · 01/{today.slice(5, 7)} → {p.month.revenueThrough ? dm(p.month.revenueThrough) : "–"}</span>
            <span className={`gc-num ${ratioCls(p.month.ratio)}`}>
              {pct(p.month.ratio)}
              <span className="gc-of"> / mục tiêu {pct(t.ratio)}</span>
            </span>
            <span className="gc-src">
              = {tr(p.month.spentWithRevenue)} chi thật ÷ {tr(p.month.revenue)} doanh thu, chỉ những ngày đã có doanh thu Pancake.
            </span>
          </div>
          <div className="goalcard">
            <span className="gc-name">Hôm qua {p.yesterday ? dm(p.yesterday.ngay) : ""}</span>
            <span className={`gc-num ${ratioCls(p.yesterday?.ratio ?? null)}`}>{p.yesterday ? pct(p.yesterday.ratio) : "–"}</span>
            <span className="gc-src">
              {p.yesterday
                ? `Chi ${vnd(p.yesterday.spent)}đ · doanh thu ${p.yesterday.revenue == null ? "Pancake chưa về" : `${vnd(p.yesterday.revenue)}đ`}.`
                : "Chưa có số."}
            </span>
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
          <h2>Đang chạy theo tài khoản (đọc lúc {hm(v.active.readAt) ?? "–"})</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="l">Tài khoản</th>
                  <th className="l">Chiến dịch đang chạy</th>
                  <th>Nhóm đang chạy</th>
                  <th>Ngân sách/ngày (Meta)</th>
                  <th>Chi thật/ngày</th>
                </tr>
              </thead>
              <tbody>
                {v.active.byAccount.map((a) => (
                  <tr key={a.id}>
                    <td className="l">{a.name}</td>
                    <td className="l">{a.campaigns.join(", ")}</td>
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
          <p className="sub">{v.active ? `Không có nhóm quảng cáo nào đang chạy (đọc Meta lúc ${hm(v.active.readAt) ?? "–"}).` : "Chưa đọc được ngân sách đang bật từ Meta."}</p>
        </div>
      )}

      <div className="card">
        <h2>Kế hoạch chưa lên (nháp ở màn Lên camp)</h2>
        {v.drafts.length ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="l">Nháp</th>
                    <th className="l">Page</th>
                    <th>Số bài</th>
                    <th>Ngân sách/ngày (Meta)</th>
                    <th>Chi thật/ngày</th>
                    <th>Hẹn chạy</th>
                  </tr>
                </thead>
                <tbody>
                  {v.drafts.map((d) => (
                    <tr key={d.id}>
                      <td className="l">{d.name}</td>
                      <td className="l">{d.page}</td>
                      <td>{d.items}</td>
                      <td>{d.metaDaily ? vnd(d.metaDaily) : "chưa nhập ngân sách"}</td>
                      <td>{d.metaDaily ? vnd(d.metaDaily * 1.111) : "–"}</td>
                      <td>{d.start_time ? d.start_time.replace("T", " ") : "khi bật"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub" style={{ marginTop: 6 }}>
              Các nháp này được cộng vào dự chi hôm nay. Nháp nào đã lên quảng cáo thật thì xóa ở <a href="/fb/len-camp">màn Lên camp</a>, không thì bị tính hai lần (một lần ở nháp, một
              lần ở phần đang chạy).
            </p>
          </>
        ) : (
          <p className="sub">
            Chưa có nháp nào. Ở <a href="/fb/len-camp">màn Lên camp</a>, chọn bài, bấm Xem trước rồi Lưu nháp: ngân sách của nháp sẽ được cộng vào dự chi ở trang này.
          </p>
        )}
      </div>

      <div className="card">
        <h2>Từng ngày trong tháng</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="l">Ngày</th>
                <th>Chi thật</th>
                <th>So mục tiêu ngày</th>
                <th>Đơn chốt (Pancake)</th>
                <th>Doanh thu (Pancake)</th>
                <th>QC / doanh thu</th>
                <th>Trong đó đơn gắn mã QC</th>
              </tr>
            </thead>
            <tbody>
              {[...v.days].reverse().map((d) => {
                const has = d.hasRevenue !== false;
                const r = has && d.revenue > 0 ? d.spendReal / d.revenue : null;
                const diff = p.today.target == null ? null : d.spendReal - p.today.target;
                return (
                  <tr key={d.ngay}>
                    <td className="l">{dm(d.ngay)}{d.ngay === today ? " (đang chạy)" : ""}</td>
                    <td>{vnd(d.spendReal)}</td>
                    <td>{diff == null ? "–" : `${diff >= 0 ? "+" : "−"}${vnd(Math.abs(diff))}`}</td>
                    <td>{has ? d.orders : "chưa về"}</td>
                    <td>{has ? vnd(d.revenue) : "chưa về"}</td>
                    <td className={ratioCls(r)}>{pct(r)}</td>
                    <td>{vnd(d.adRevenue ?? 0)}</td>
                  </tr>
                );
              })}
              {v.days.length === 0 ? (
                <tr>
                  <td className="l" colSpan={7}>Tháng này chưa có số quảng cáo nào.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
