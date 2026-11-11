import { isDryRun, shops } from "@/lib/autopilot/config";
import { DEFAULT_RULE_PARAMS, formatHours, loadSettings, suggestDays } from "@/lib/autopilot/settings";

export const dynamic = "force-dynamic";

const PARAM_LABELS: Record<keyof typeof DEFAULT_RULE_PARAMS, string> = {
  scale_spend_ratio: "Tăng NS khi đã tiêu ≥ (tỉ lệ ngân sách, vd 0,8)",
  scale_step_pct: "Mỗi lần tăng (%)",
  scale_min_step: "Bước tăng nhỏ nhất (đ)",
  cut_window_hours: "Tạm dừng: khung xét (giờ, ≥ 3)",
  cut_min_clicks: "Tạm dừng: số click tối thiểu trong khung",
  cut_min_expense: "Tạm dừng: chi tối thiểu trong khung (đ)",
  cut_roas_ratio: "Tạm dừng khi ROAS khung < (tỉ lệ mục tiêu, vd 0,4)",
  cut_roas_floor: "…hoặc < ROAS này nếu không có mục tiêu",
  cut_day_roas_ratio: "…và ROAS cả ngày < (tỉ lệ mục tiêu, vd 0,6)",
  throttle_buffer: "Siết: ngân sách = đã chi hôm nay + (đ)",
  good_hours_weeks: "Khung giờ tốt tính theo (tuần gần nhất)",
  cooldown_minutes: "Thời gian chờ giữa 2 lần chỉnh (phút)",
  proposal_ttl_minutes: "Đề xuất hết hạn sau (phút)",
  roas_low_ratio: "ROAS mục tiêu: nâng khi thực tế < (tỉ lệ, vd 0,8)",
  roas_high_ratio: "ROAS mục tiêu: hạ khi thực tế > (tỉ lệ, vd 1,2)",
  roas_max_change_pct: "ROAS mục tiêu: đổi tối đa mỗi lần (%, ≤ 15)",
  roas_min_week_expense: "ROAS mục tiêu: chỉ xét khi chi 7 ngày ≥ (đ)",
};

export default async function Settings({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { saved } = await searchParams;
  const data = await Promise.all(
    shops().map(async (s) => ({ shop: s, st: await loadSettings(s.shopId), days: await suggestDays(s.shopId) }))
  );
  const stopped = data.some((d) => d.st.emergency_stop);

  return (
    <>
      <h1>Cài đặt</h1>
      {saved ? <p className="ok">Đã lưu.</p> : null}
      <section className="card">
        <h2>Dừng khẩn cấp</h2>
        <p className="muted">
          Tắt toàn bộ tự động (đề xuất và thực thi) cho mọi shop. Không đổi gì trên Shopee.{" "}
          {isDryRun() ? <b>Đang DRY-RUN: mọi lệnh duyệt chỉ ghi log, chưa gửi Shopee.</b> : null}
        </p>
        <form method="post" action="/api/admin/settings">
          {stopped ? (
            <>
              {data.filter((d) => d.st.emergency_stop).map((d) => (
                <p className="error" key={d.shop.shopId}>
                  <b>{d.shop.name}: ĐANG DỪNG.</b> {d.st.halt_reason ?? ""}
                </p>
              ))}
              <input type="hidden" name="action" value="emergency_release" />
              <button type="submit">Gỡ dừng khẩn cấp</button>
            </>
          ) : (
            <>
              <input type="hidden" name="action" value="emergency_stop" />
              <button type="submit" className="danger">DỪNG KHẨN CẤP</button>
            </>
          )}
        </form>
      </section>
      {data.map(({ shop, st, days }) => (
        <section className="card" key={shop.shopId}>
          <h2>{shop.name} <span className="muted">({shop.shopId})</span></h2>
          <form method="post" action="/api/admin/settings" className="settings">
            <input type="hidden" name="action" value="save" />
            <input type="hidden" name="shop_id" value={shop.shopId} />
            <div className="grid2">
              <div>
                <label>Chế độ</label>
                <select name="mode" defaultValue={st.mode}>
                  <option value="suggest">Đề xuất, anh duyệt (suggest)</option>
                  <option value="auto" disabled={days < 7}>Tự động (auto){days < 7 ? ` — sau ${(7 - days).toFixed(1)} ngày nữa` : ""}</option>
                  <option value="off">Tắt</option>
                </select>
                <p className="muted">Đã chạy đề xuất {days.toFixed(1)} ngày.</p>
                <label>Trần tổng ngân sách/ngày — ngày thường (đ)</label>
                <input name="daily_cap_normal" inputMode="numeric" defaultValue={st.daily_cap_normal ?? ""} placeholder="vd 15000000" />
                <label>Trần tổng ngân sách/ngày — ngày sale (đ)</label>
                <input name="daily_cap_sale" inputMode="numeric" defaultValue={st.daily_cap_sale ?? ""} />
                <label>Ngày sale thêm (YYYY-MM-DD, cách nhau dấu phẩy; ngày đôi 1/1…12/12 tự tính)</label>
                <input name="sale_dates" defaultValue={st.sale_dates.join(", ")} placeholder="2026-11-25, 2026-12-25" />
                <label>Ngân sách tối đa mỗi chiến dịch (đ)</label>
                <input name="campaign_cap" inputMode="numeric" defaultValue={st.campaign_cap ?? ""} />
              </div>
              <div>
                <label>Mỗi lần tăng tối đa (%, ≤ 30)</label>
                <input name="max_increase_pct" inputMode="numeric" defaultValue={st.max_increase_pct} />
                <label>Số lần chỉnh mỗi chiến dịch/ngày</label>
                <input name="max_edits_per_day" inputMode="numeric" defaultValue={st.max_edits_per_day} />
                <label>Ngân sách khởi điểm lúc 0h (đ)</label>
                <input name="start_budget" inputMode="numeric" defaultValue={st.start_budget} />
                <label>Khung giờ tốt — nới lại ngân sách đã siết (vd: 0, 8-12, 20-22; trống = tự tính)</label>
                <input name="good_hours" defaultValue={st.good_hours.length ? formatHours(st.good_hours).replace(/h/g, "").replace(/–/g, "-") : ""} placeholder="0, 8-12, 20-22" />
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" name="reset_unlimited" defaultChecked={st.reset_unlimited} style={{ width: "auto" }} />
                  Reset 0h áp dụng cả chiến dịch đang <b>không giới hạn</b> ngân sách
                </label>
              </div>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary><b>Tham số luật</b> <span className="muted">(để trống = mặc định)</span></summary>
              <div className="grid2">
                {(Object.keys(DEFAULT_RULE_PARAMS) as (keyof typeof DEFAULT_RULE_PARAMS)[]).map((k) => (
                  <div key={k}>
                    <label>{PARAM_LABELS[k]}</label>
                    <input name={`p_${k}`} inputMode="decimal" defaultValue={st.params[k] === DEFAULT_RULE_PARAMS[k] ? "" : st.params[k]} placeholder={String(DEFAULT_RULE_PARAMS[k])} />
                  </div>
                ))}
              </div>
            </details>
            <p><button type="submit">Lưu</button></p>
          </form>
        </section>
      ))}
    </>
  );
}
