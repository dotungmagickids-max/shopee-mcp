import { recentLog } from "@/lib/autopilot/dashboard";
import { shopName } from "@/lib/autopilot/config";

export const dynamic = "force-dynamic";

const t = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "-";
const j = (v: unknown) => (v == null ? "" : JSON.stringify(v));

export default async function Log() {
  const { actions, runs, audit } = await recentLog(100);
  return (
    <>
      <h1>Nhật ký</h1>
      <section className="card">
        <h2>Thay đổi và đề xuất</h2>
        {actions.length === 0 ? (
          <p className="muted">Chưa có thay đổi nào.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Lúc</th><th className="l">Shop / chiến dịch</th><th>Hành động</th><th>Nguồn</th><th className="l">Trước → sau</th><th>Trạng thái</th><th className="l">Lý do</th></tr>
              </thead>
              <tbody>
                {actions.map((a: any) => (
                  <tr key={a.id}>
                    <td>{t(a.created_at)}</td>
                    <td className="l">{a.shop_id ? `${shopName(Number(a.shop_id))} (${a.shop_id})` : "Tất cả"}{a.campaign_id ? ` · #${a.campaign_id}` : ""}</td>
                    <td>{a.action}</td>
                    <td>{a.source}</td>
                    <td className="l"><code>{j(a.before)}</code> → <code>{j(a.after)}</code></td>
                    <td>{a.status}</td>
                    <td className="l">{a.reason}{a.error ? <span className="error"> {a.error}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Lần chạy job</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Bắt đầu</th><th>Job</th><th className="l">Shop</th><th>Thời gian</th><th>Kết quả</th><th className="l">Lỗi</th></tr></thead>
            <tbody>
              {runs.map((r: any) => (
                <tr key={r.id}>
                  <td>{t(r.started_at)}</td>
                  <td>{r.job}</td>
                  <td className="l">{r.shop_id ? shopName(Number(r.shop_id)) : ""}</td>
                  <td>{r.finished_at ? `${Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)}s` : "đang chạy"}</td>
                  <td>{r.ok == null ? "-" : r.ok ? <span className="ok">OK</span> : <span className="error">Lỗi</span>}</td>
                  <td className="l"><code>{String(r.error ?? "").slice(0, 300)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Gọi API Shopee (lệnh ghi và lỗi)</h2>
        {audit.length === 0 ? <p className="muted">Chưa có.</p> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Lúc</th><th className="l">Endpoint</th><th>Shop</th><th>Loại</th><th>OK</th><th className="l">Lỗi</th></tr></thead>
              <tbody>
                {audit.map((a: any, i: number) => (
                  <tr key={i}>
                    <td>{t(a.created_at)}</td>
                    <td className="l">{String(a.endpoint).replace("autopilot:", "")}</td>
                    <td>{a.shop_id}</td>
                    <td>{a.access}</td>
                    <td>{a.ok ? "✓" : "✗"}</td>
                    <td className="l"><code>{String(a.error ?? "").slice(0, 200)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
