import { shops } from "@/lib/autopilot/config";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function Settings({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { saved } = await searchParams;
  const ids = shops().map((s) => s.shopId);
  const { data } = await db().from("autopilot_settings").select("*").in("shop_id", ids);
  const byId = new Map((data ?? []).map((r: any) => [Number(r.shop_id), r]));
  const stopped = (data ?? []).some((r: any) => r.emergency_stop);

  return (
    <>
      <h1>Cài đặt</h1>
      {saved ? <p className="ok">Đã lưu.</p> : null}
      <section className="card">
        <h2>Dừng khẩn cấp</h2>
        <p className="muted">Tắt toàn bộ tự động (đề xuất và thực thi) cho mọi shop. Không đổi gì trên Shopee.</p>
        <form method="post" action="/api/admin/settings">
          {stopped ? (
            <>
              <p className="error"><b>Đang DỪNG KHẨN CẤP.</b></p>
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
      {shops().map((s) => {
        const r = byId.get(s.shopId) ?? {};
        const v = (k: string) => (r[k] == null ? "" : String(r[k]));
        return (
          <section className="card" key={s.shopId}>
            <h2>{s.name} <span className="muted">({s.shopId})</span></h2>
            <form method="post" action="/api/admin/settings" className="settings">
              <input type="hidden" name="action" value="save" />
              <input type="hidden" name="shop_id" value={s.shopId} />
              <div className="grid2">
                <div>
                  <label>Chế độ</label>
                  <select name="mode" defaultValue={v("mode") || "suggest"}>
                    <option value="suggest">Chỉ đề xuất (suggest)</option>
                    <option value="off">Tắt</option>
                  </select>
                  <p className="muted">Chế độ tự động (auto) mở sau khi chạy đề xuất ≥ 7 ngày.</p>
                  <label>Trần tổng ngân sách/ngày — ngày thường (đ)</label>
                  <input name="daily_cap_normal" inputMode="numeric" defaultValue={v("daily_cap_normal")} placeholder="vd 15000000" />
                  <label>Trần tổng ngân sách/ngày — ngày sale (đ)</label>
                  <input name="daily_cap_sale" inputMode="numeric" defaultValue={v("daily_cap_sale")} />
                  <label>Ngân sách tối đa mỗi chiến dịch (đ)</label>
                  <input name="campaign_cap" inputMode="numeric" defaultValue={v("campaign_cap")} />
                </div>
                <div>
                  <label>Mỗi lần tăng tối đa (%, ≤ 30)</label>
                  <input name="max_increase_pct" inputMode="numeric" defaultValue={v("max_increase_pct")} />
                  <label>Số lần chỉnh mỗi chiến dịch/ngày</label>
                  <input name="max_edits_per_day" inputMode="numeric" defaultValue={v("max_edits_per_day")} />
                  <label>Ngân sách khởi điểm lúc 0h (đ)</label>
                  <input name="start_budget" inputMode="numeric" defaultValue={v("start_budget")} />
                </div>
              </div>
              <p><button type="submit">Lưu</button></p>
            </form>
          </section>
        );
      })}
    </>
  );
}
