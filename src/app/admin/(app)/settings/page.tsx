import { isDryRun, liveActions, shops } from "@/lib/autopilot/config";
import { DEFAULT_RULE_PARAMS, formatHours, loadSettings, SALE_TIER_VI, saleTier, suggestDays } from "@/lib/autopilot/settings";

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
  profit_target_pct: "Lãi mong muốn sau quảng cáo (% giá bán)",
  extra_cost_per_unit: "Chi phí khác mỗi sản phẩm bán ra (đ: đóng gói, nhân công…)",
  use_profit_roas: "Luật dùng ROAS theo lãi (1 = bật, 0 = dùng ROAS mục tiêu đang đặt)",
  ad_fee_pct: "Phí nạp ví quảng cáo (%): chi QC thật = chi Shopee báo × (1 + %)",
  return_fee_per_order: "Phí mỗi đơn hoàn / giao thất bại (đ)",
  profit_core_pct: "Nhóm Chủ lực: lãi mong muốn (%)",
  profit_new_pct: "Nhóm Mới: lãi mong muốn (%, 0 = hòa vốn để học)",
  clear_profit_pct: "Nhóm Xả kho: lãi mong muốn (%; âm = chấp nhận lỗ để đẩy hàng)",
  system_profit_floor_pct: "Sàn lãi toàn hệ thống (%): gần sàn thì dừng tăng nhóm lãi mỏng",
  mix_core_pct: "Cơ cấu mục tiêu: Chủ lực % tổng chi (ưu tiên tăng khi thấp hơn)",
  mix_regular_pct: "Cơ cấu mục tiêu: Thường % tổng chi (ưu tiên tăng khi thấp hơn)",
  clear_max_spend_share_pct: "Xả kho: tối đa % tổng chi quảng cáo trong ngày",
  new_max_spend_share_pct: "Mới: tối đa % tổng chi quảng cáo trong ngày",
  new_days: "Tự phân nhóm Mới: sản phẩm tạo chưa tới (ngày)",
  clear_stock_days: "Tự phân nhóm Xả kho: tồn đủ bán ≥ (ngày)",
  clear_min_stock: "…và còn ≥ (cái), áp dụng cả hàng trái mùa",
  core_min_units: "Tự phân nhóm Chủ lực: bán ≥ (cái / 30 ngày)",
  core_max_cost_pct: "…giá vốn ≤ (% giá bán)",
  core_min_stock_days: "…tồn đủ bán ≥ (ngày)",
  peak_scale_spend_ratio: "Ngày cao điểm: tăng khi đã tiêu ≥ (tỉ lệ ngân sách)",
  peak_scale_step_pct: "Ngày cao điểm: mỗi lần tăng (%)",
  peak_max_increase_pct: "Ngày cao điểm: trần mỗi lần tăng (%)",
  peak_cooldown_minutes: "Ngày cao điểm: nghỉ giữa 2 lần chỉnh (phút)",
  peak_max_edits_per_day: "Ngày cao điểm: số lần chỉnh/chiến dịch/ngày",
  scale_core_profit_pct: "Chủ lực (ngôi sao): tăng ngân sách khi còn lãi ≥ (%)",
  scale_decay_pct: "Phanh tăng: ROAS hôm nay < % ROAS 7 ngày thì thôi tăng (0 = tắt)",
  scale_decay_min_spend: "Phanh tăng: chỉ xét khi hôm nay đã tiêu ≥ (đ)",
  scale_core_spend_ratio: "Chủ lực (ngôi sao): tăng khi đã tiêu ≥ (tỉ lệ ngân sách)",
  scale_core_step_pct: "Chủ lực (ngôi sao): mỗi lần tăng (%)",
  start_share_pct: "Ngân sách 0h = % chi trung bình 7 ngày thường của chiến dịch",
  burn_trigger_minutes: "Tăng ngay khi với tốc độ hiện tại còn ≤ N phút là hết tiền",
  burn_cover_hours: "Khi tiêu nhanh: thêm đủ tiêu tiếp N giờ",
  fast_max_increase_pct: "Khi tiêu nhanh: trần mỗi lần tăng (%)",
  fast_cooldown_minutes: "Khi tiêu nhanh: nghỉ giữa 2 lần tăng (phút)",
  fast_max_edits_per_day: "Khi tiêu nhanh: số lần chỉnh/chiến dịch/ngày",
  early_spend_pct: "Đầu ngày (đã tiêu < % mức chi ngày thường): xét ROAS 3 ngày",
  launch_max_per_week: "Lên quảng cáo mã mới: tối đa mã đề xuất/tuần",
  launch_min_stock: "Lên quảng cáo mã mới: tồn tối thiểu (cái)",
  launch_min_stock_days: "Lên quảng cáo mã mới: tồn đủ bán tối thiểu (ngày)",
  launch_max_breakeven: "Lên quảng cáo mã mới: bỏ mã có ROAS hòa vốn cao hơn",
  launch_cooldown_days: "Lên quảng cáo mã mới: mã đã đề xuất thì N ngày sau mới đề xuất lại",
  auto_reset: "Reset 0h tự chạy không chờ duyệt (1 = bật)",
  auto_roas: "Đổi ROAS mục tiêu hằng đêm (≤ ±15%) tự chạy không chờ duyệt (1 = bật)",
  roas_live: "Đổi ROAS mục tiêu gửi thật lên Shopee (1 = bật, 0 = thử)",
  launch_live: "Lên quảng cáo mã mới: duyệt là tạo thật trên Shopee (1 = bật, 0 = thử)",
  new_promote_orders: "Đánh giá hàng Mới: đủ N đơn/14 ngày và lãi 10% thì đề xuất lên nhóm",
  new_stop_min_spend: "Đánh giá hàng Mới: đã chi ≥ (đ) mà không ra đơn/lỗ thì báo nên dừng",
  auto_scale_up: "Tự chạy việc tăng ngân sách không chờ duyệt (1 = bật, 0 = tắt)",
  goal_month_revenue: "Mục tiêu doanh số tháng của shop (đ, 0 = chưa đặt)",
  goal_profit_pct: "Mục tiêu lãi cả tháng (% doanh số)",
  clear_deadline: "Hạn bán hết hàng xả (YYYYMMDD, vd 20270117; 0 = chưa đặt)",
  steps_enabled: "Thử bậc lãi tự động cho Chủ lực / Thường (1 = bật)",
  steps_max_running: "Thử bậc: số chiến dịch thử cùng lúc",
  steps_test_days: "Thử bậc: số ngày thường đo mỗi bậc",
  steps_max_days: "Thử bậc: chấm sau tối đa N ngày lịch",
  steps_base_days: "Thử bậc: số ngày nền tối đa trước khi đổi",
  steps_min_base_days: "Thử bậc: cần ≥ N ngày thường ở bậc hiện tại",
  steps_roas_pct: "Thử bậc: mỗi bậc đổi ROAS mục tiêu khoảng (%)",
  steps_min_pct: "Thử bậc: lãi mong muốn thấp nhất (%)",
  steps_max_pct: "Thử bậc: lãi mong muốn cao nhất (%)",
  steps_min_daily_spend: "Thử bậc: chỉ thử chiến dịch chi TB ≥ (đ/ngày thường)",
  steps_gain_pct: "Thử bậc: lãi/ngày hơn kém ≥ N% mới tính là khác",
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
          {isDryRun() ? (
            <b>
              Đang DRY-RUN: lệnh duyệt chỉ ghi log, chưa gửi Shopee
              {liveActions().length ? ` — trừ ${liveActions().join(", ")} (chạy thật)` : ""}.
            </b>
          ) : null}
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
                <p className="muted">Hôm nay: <b>{SALE_TIER_VI[saleTier(st)]}</b>. Cầu chì chỉ chặn lỗi (chạm thì báo Telegram và dừng tăng, không giảm gì) — không phải mức chi mục tiêu.</p>
                <label>Cầu chì tổng ngân sách/ngày — ngày thường + sale nhỏ (đ)</label>
                <input name="daily_cap_normal" inputMode="numeric" defaultValue={st.daily_cap_normal ?? ""} placeholder="vd 30000000" />
                <label>Cầu chì tổng ngân sách/ngày — ngày sale lớn + ngày trước sale (đ)</label>
                <input name="daily_cap_sale" inputMode="numeric" defaultValue={st.daily_cap_sale ?? ""} placeholder="vd 80000000" />
                <label>Ngày sale lớn thêm (YYYY-MM-DD, cách nhau dấu phẩy; ngày đôi 1/1…12/12 tự tính)</label>
                <input name="sale_dates" defaultValue={st.sale_dates.join(", ")} placeholder="2026-11-27, 2026-12-25" />
                <label>Số ngày trước ngày sale lớn cũng chạy chế độ cao điểm</label>
                <input name="pre_sale_days" inputMode="numeric" defaultValue={st.pre_sale_days} />
                <label>Ngày sale nhỏ hằng tháng (ngày trong tháng)</label>
                <input name="mini_sale_days" defaultValue={st.mini_sale_days.join(", ")} placeholder="1, 15, 20, 25" />
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
