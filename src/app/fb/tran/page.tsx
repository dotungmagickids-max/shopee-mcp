import { listCeilings } from "@/lib/facebook/magic-data";

export const dynamic = "force-dynamic";

export default async function CeilingPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  const { rows, error } = await listCeilings();
  const p = (x: number) => Math.round(Number(x) * 1000) / 10;
  return (
    <div className="card">
      <h1>Bảng trần chi/doanh thu theo mã</h1>
      <p className="sub">
        Chi thật / doanh thu: dưới trần lãi = xanh, giữa trần lãi và hòa vốn = vàng, vượt hòa vốn = đỏ. Dòng <b>*</b> là mặc định cho mọi
        mã chưa có dòng riêng. Quảng cáo nhiều mã lấy trần chặt nhất.
      </p>
      {msg ? <p className="warnbox">{msg}</p> : null}
      {error ? <p className="error">Chưa đọc được bảng fb_ceilings ({error}). Cần chạy migration 0023; trong lúc đó dùng mặc định 20% / 36%.</p> : null}
      <form method="post" action="/api/fb/ceilings" className="filters" style={{ margin: "12px 0" }}>
        <input name="product_code" placeholder="Mã, vd BD26011 hoặc *" required size={14} />
        <input name="profit_ceiling" placeholder="Trần lãi %" required size={8} inputMode="decimal" />
        <input name="breakeven" placeholder="Hòa vốn %" required size={8} inputMode="decimal" />
        <input name="note" placeholder="Ghi chú" size={24} />
        <button type="submit">Lưu</button>
      </form>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="l">Mã</th>
              <th>Trần lãi</th>
              <th>Hòa vốn</th>
              <th className="l">Ghi chú</th>
              <th>Sửa lúc</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_code}>
                <td className="l"><b>{r.product_code}</b></td>
                <td>{p(r.profit_ceiling)}%</td>
                <td>{p(r.breakeven)}%</td>
                <td className="l">{r.note}</td>
                <td>{new Date(r.updated_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</td>
                <td>
                  {r.product_code !== "*" ? (
                    <form method="post" action="/api/fb/ceilings" style={{ margin: 0 }}>
                      <input type="hidden" name="product_code" value={r.product_code} />
                      <input type="hidden" name="delete" value="1" />
                      <button type="submit" className="secondary">Xóa</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
