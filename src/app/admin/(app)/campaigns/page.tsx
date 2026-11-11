import { campaignsWithRanking, econSummary, type CampaignRow } from "@/lib/autopilot/dashboard";
import type { EconSummary } from "@/lib/autopilot/profit";
import { shops } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";
import { Proposals } from "../proposals";

export const dynamic = "force-dynamic";

const TAG: Record<string, string> = { "tăng": "tang", "giảm": "giam", "tắt": "tat" };
const ORDER: Record<string, number> = { "tắt": 0, "giảm": 1, "tăng": 2, "giữ": 3, "chờ số liệu": 4 };

function Edit({ shopId, r }: { shopId: number; r: CampaignRow }) {
  const hidden = (op: string) => (
    <>
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="shop_id" value={shopId} />
      <input type="hidden" name="campaign_id" value={r.campaign_id} />
      <input type="hidden" name="back" value="/admin/campaigns" />
    </>
  );
  const small = { padding: "4px 10px", fontSize: 13 } as const;
  const input = { width: 110, padding: 4, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)" } as const;
  return (
    <details>
      <summary>Sửa</summary>
      <div style={{ display: "grid", gap: 6, marginTop: 6, justifyItems: "end" }}>
        <form method="post" action="/api/admin/actions">
          {hidden("edit")}
          <input type="hidden" name="kind" value="change_budget" />
          <input name="value" inputMode="numeric" placeholder="Ngân sách đ" style={input} required />{" "}
          <button type="submit" style={small}>Đặt NS</button>
        </form>
        {r.bidding_method === "auto" ? (
          <form method="post" action="/api/admin/actions">
            {hidden("edit")}
            <input type="hidden" name="kind" value="change_roas_target" />
            <input name="value" inputMode="decimal" placeholder={`ROAS (${r.roas_target ?? "-"})`} style={input} required />{" "}
            <button type="submit" style={small}>Đặt ROAS</button>
          </form>
        ) : null}
        <form method="post" action="/api/admin/actions">
          {hidden("edit")}
          <input type="hidden" name="kind" value={r.campaign_status === "paused" ? "resume" : "pause"} />
          <button type="submit" style={small}>{r.campaign_status === "paused" ? "Bật lại" : "Tạm dừng"}</button>
        </form>
        <form method="post" action="/api/admin/actions">
          {hidden("exclude")}
          <input type="hidden" name="excluded" value={r.excluded ? "0" : "1"} />
          <button type="submit" className="secondary" style={{ ...small, margin: 0 }}>
            {r.excluded ? "Đưa lại vào tự động" : "Loại khỏi tự động"}
          </button>
        </form>
      </div>
    </details>
  );
}

const pct = (x: number) => `${(x * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;

function EconBox({ econ }: { econ: EconSummary | null }) {
  if (!econ) return <p className="muted">Lãi: chưa tính (job giá vốn chạy 01:15 mỗi đêm, cần PANCAKE_API_KEY).</p>;
  const f = econ.fees;
  return (
    <details style={{ margin: "8px 0" }}>
      <summary>
        <b>Lãi</b>: tiền về {pct(f.payout)} giá bán{f.estimated ? " (ước tính, chưa đủ escrow)" : ` (${f.orders} đơn thật)`} · giá vốn TB{" "}
        {pct(econ.shop.cost_ratio)} · hủy {pct(econ.cancel_rate)} · hoàn {pct(econ.return_rate)} giá bán · ROAS hòa vốn TB{" "}
        <b>{econ.shop.breakeven ?? "lỗ"}</b> · ROAS cho lãi {econ.shop.profit_pct}%: <b>{econ.shop.target ?? "không đạt"}</b>
      </summary>
      <div className="muted" style={{ marginTop: 6 }}>
        {f.fees.length ? (
          <>
            Phí Shopee trên giá bán (escrow {f.orders} đơn hoàn tất 45 ngày):{" "}
            {f.fees.map((x) => `${x.label} ${pct(x.ratio)}`).join(" · ")}.
          </>
        ) : (
          "Chưa đủ 20 đơn có escrow: tạm dùng tiền về 70% giá bán."
        )}{" "}
        Hủy (kể cả giao thất bại) và hoàn tính trên {econ.rate_orders} đơn tạo từ 45 tới 10 ngày trước. Đơn hủy không có tiền về,
        không tốn giá vốn.{" "}
        {econ.return_source === "returns" ? (
          <>
            Hoàn = tiền hoàn theo yêu cầu trả hàng Shopee / giá bán; {pct(econ.return_back_rate ?? econ.return_rate)} có hàng gửi về shop
            (thu lại giá vốn), phần còn lại chỉ hoàn tiền (mất hàng).
            {econ.return_reasons?.length ? <> Lý do hoàn: {econ.return_reasons.map((r) => `${r.label} ${pct(r.ratio)}`).join(" · ")}.</> : null}
            {" "}Sản phẩm đủ doanh số dùng tỉ lệ hoàn riêng.
          </>
        ) : (
          "Hoàn đang ước theo trạng thái đơn (chưa có dữ liệu trả hàng)."
        )} {econ.item_level}/{econ.campaigns} chiến dịch đủ số liệu riêng, còn lại dùng số TB shop. Cập nhật{" "}
        {new Date(econ.at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}.
      </div>
    </details>
  );
}

export default async function Campaigns({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const data = await Promise.all(
    shops().map(async (s) => ({ shop: s, rows: await campaignsWithRanking(s.shopId), econ: await econSummary(s.shopId) }))
  );
  return (
    <>
      <h1>Chiến dịch</h1>
      <p className="muted">
        Chiến dịch GMV Max theo sản phẩm (API ghi “manual” nhưng đặt giá thầu tự động theo ROAS).
        Xếp hạng dựa trên 7 ngày D-8…D-2 (bỏ 2 ngày gần nhất vì đơn còn được ghi nhận thêm).
        Sửa trên trang này vẫn qua trần cứng; khi DRY-RUN chỉ ghi log, chưa gửi Shopee.
      </p>
      <p className="muted">
        <b>Hòa vốn / Theo lãi</b>: ROAS (theo số Shopee) để không lỗ và để đạt lãi mong muốn (Cài đặt), tính hằng đêm từ giá vốn
        Pancake, giá bán 30 ngày, phí Shopee thật (escrow) và tỉ lệ hủy/hoàn. <span>*</span> = sản phẩm bán ít, dùng số trung bình shop.
      </p>
      {msg ? <p className="warning">{msg}</p> : null}
      <Proposals back="/admin/campaigns" />
      {data.map(({ shop, rows, econ }) => {
        const sorted = [...rows].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.today.expense - a.today.expense);
        const unlimited = rows.filter((r) => r.campaign_budget === 0 && r.campaign_status === "ongoing").length;
        return (
          <section className="card" key={shop.shopId}>
            <h2>
              {shop.name} <span className="muted">({shop.shopId}) · {rows.length} chiến dịch</span>
            </h2>
            <form method="post" action="/api/admin/actions" style={{ marginBottom: 8 }}>
              <input type="hidden" name="op" value="refresh" />
              <input type="hidden" name="shop_id" value={shop.shopId} />
              <input type="hidden" name="back" value="/admin/campaigns" />
              <button type="submit" className="secondary" style={{ padding: "4px 10px", fontSize: 13, margin: 0, border: "1px solid var(--border)" }}>
                Rà chiến dịch cần làm mới
              </button>{" "}
              <span className="muted">Tự chạy 7h sáng thứ Hai; luôn chờ anh duyệt.</span>
            </form>
            <EconBox econ={econ} />
            {unlimited ? (
              <p className="warning">
                {unlimited} chiến dịch đang chạy để ngân sách <b>không giới hạn</b> (campaign_budget = 0).{" "}
                <form method="post" action="/api/admin/actions" style={{ display: "inline" }}>
                  <input type="hidden" name="op" value="caps" />
                  <input type="hidden" name="shop_id" value={shop.shopId} />
                  <input type="hidden" name="back" value="/admin/campaigns" />
                  <button type="submit" style={{ padding: "4px 10px", fontSize: 13 }}>Đề xuất hạn mức</button>
                </form>
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
                      <th title="ROAS hòa vốn / ROAS cần cho lãi mong muốn (giá vốn Pancake)">Hòa vốn / Theo lãi</th>
                      <th>Chi hôm nay</th>
                      <th>ROAS hôm nay</th>
                      <th>Chi 7 ngày</th>
                      <th>ROAS 7 ngày</th>
                      <th title="GMV × lãi trước QC − chi QC, 7 ngày D-8…D-2">Lãi 7 ngày (ước)</th>
                      <th>Đơn 7 ngày</th>
                      <th>Click 7 ngày</th>
                      <th className="l">Đề xuất</th><th></th>
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
                        <td title={r.econ ? `Giá bán TB ${vnd(r.econ.price)}, giá vốn ${Math.round(r.econ.cost_ratio * 100)}%, tiền về ${Math.round(r.econ.payout * 100)}%, hủy ${Math.round(r.econ.cancel_rate * 100)}%, hoàn ${Math.round((r.econ.return_rate ?? 0) * 100)}%${r.econ.return_source === "item" ? " (riêng SP)" : ""}${r.econ.source === "shop" ? " — số TB shop (sản phẩm bán ít)" : ""}` : "Chưa có giá vốn"}>
                          {r.econ ? (
                            <>
                              {r.econ.breakeven ?? "lỗ"} / <b>{r.econ.target ?? "không đạt"}</b>
                              {r.econ.source === "shop" ? <span className="muted"> *</span> : null}
                            </>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>{vnd(r.today.expense)}</td>
                        <td>{r.today.expense > 0 ? (r.today.gmv / r.today.expense).toFixed(1) : "-"}</td>
                        <td>{vnd(r.week.expense)}</td>
                        <td>{r.week.expense > 0 ? r.week.roas.toFixed(1) : "-"}</td>
                        <td className={r.weekProfit != null && r.weekProfit < 0 ? "neg" : undefined}>{r.weekProfit == null ? "-" : vnd(r.weekProfit)}</td>
                        <td>{r.week.orders}</td>
                        <td>{r.week.clicks}</td>
                        <td className="l">
                          <span className={`tag ${TAG[r.verdict] ?? ""}`}>{r.verdict}</span> <span className="muted">{r.reason}</span>
                          {r.excluded ? <> <span className="tag">không tự động</span></> : null}
                          {r.toolPaused ? <> <span className="tag">tool dừng tới 0h</span></> : null}
                          {r.throttled ? <> <span className="tag giam">đang siết ngân sách</span></> : null}
                        </td>
                        <td><Edit shopId={shop.shopId} r={r} /></td>
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
