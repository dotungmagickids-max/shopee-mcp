import { campaignsWithRanking } from "@/lib/autopilot/dashboard";
import { shops } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";

export const dynamic = "force-dynamic";

const TAG: Record<string, string> = { "tăng": "tang", "giảm": "giam", "tắt": "tat" };
const ORDER: Record<string, number> = { "tắt": 0, "giảm": 1, "tăng": 2, "giữ": 3, "chờ số liệu": 4 };

export default async function Campaigns() {
  const data = await Promise.all(shops().map(async (s) => ({ shop: s, rows: await campaignsWithRanking(s.shopId) })));
  return (
    <>
      <h1>Chiến dịch đang chạy</h1>
      <p className="muted">
        Chiến dịch GMV Max theo sản phẩm (API ghi “manual” nhưng đặt giá thầu tự động theo ROAS).
        Đề xuất dựa trên 7 ngày D-8…D-2 (bỏ 2 ngày gần nhất vì đơn còn được ghi nhận thêm). Giai đoạn này chỉ xem, chưa sửa.
      </p>
      {data.map(({ shop, rows }) => {
        const sorted = [...rows].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.today.expense - a.today.expense);
        const unlimited = rows.filter((r) => r.campaign_budget === 0 && r.campaign_status === "ongoing").length;
        return (
          <section className="card" key={shop.shopId}>
            <h2>
              {shop.name} <span className="muted">({shop.shopId}) · {rows.length} chiến dịch</span>
            </h2>
            {unlimited ? (
              <p className="warning">
                {unlimited} chiến dịch đang chạy để ngân sách <b>không giới hạn</b> (campaign_budget = 0).
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="muted">Không có chiến dịch đang chạy.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th className="l">Chiến dịch</th>
                      <th>Trạng thái</th>
                      <th>Ngân sách/ngày</th>
                      <th>ROAS mục tiêu</th>
                      <th>Chi hôm nay</th>
                      <th>ROAS hôm nay</th>
                      <th>Chi 7 ngày</th>
                      <th>ROAS 7 ngày</th>
                      <th>Đơn 7 ngày</th>
                      <th>Click 7 ngày</th>
                      <th className="l">Đề xuất</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => (
                      <tr key={r.campaign_id}>
                        <td className="l">
                          {r.ad_name ?? "(không tên)"}
                          <br />
                          <span className="muted">#{r.campaign_id}{r.bidding_method === "auto" ? " · GMV Max" : ""}</span>
                        </td>
                        <td>{r.campaign_status === "ongoing" ? "Đang chạy" : r.campaign_status === "paused" ? "Tạm dừng" : r.campaign_status}</td>
                        <td>{r.campaign_budget === 0 ? <span className="tag unlimited">Không giới hạn</span> : vnd(r.campaign_budget)}</td>
                        <td>{r.roas_target ?? "-"}</td>
                        <td>{vnd(r.today.expense)}</td>
                        <td>{r.today.expense > 0 ? (r.today.gmv / r.today.expense).toFixed(1) : "-"}</td>
                        <td>{vnd(r.week.expense)}</td>
                        <td>{r.week.expense > 0 ? r.week.roas.toFixed(1) : "-"}</td>
                        <td>{r.week.orders}</td>
                        <td>{r.week.clicks}</td>
                        <td className="l">
                          <span className={`tag ${TAG[r.verdict] ?? ""}`}>{r.verdict}</span> <span className="muted">{r.reason}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
