import { CLASSES, CLASS_BCG, CLASS_VI, type ProductClass } from "@/lib/autopilot/classes";
import { shops } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const VIEWS: { key: string; label: string }[] = [
  { key: "de_xuat", label: "Có đề xuất chuyển nhóm" },
  { key: "moi", label: "Dấu hỏi (Mới / chưa chạy QC)" },
  { key: "chu_luc", label: "Ngôi sao (Chủ lực)" },
  { key: "thuong", label: "Bò sữa (Thường)" },
  { key: "xa_kho", label: "Chó (Xả kho)" },
  { key: "all", label: "Tất cả" },
];

const SOURCE_VI: Record<string, string> = { manual: "anh chọn", auto: "tự động", chua_qc: "chưa chạy QC" };

interface Row {
  shop_id: number;
  item_id: number;
  name: string | null;
  image: string | null;
  price: number | null;
  stock: number | null;
  days_of_stock: number | null;
  units7: number;
  units30: number;
  cost_ratio: number | null;
  breakeven: number | null;
  profit_pct: number | null;
  profit_source: string | null;
  in_ads: boolean;
  ad_spend14: number;
  ad_gmv14: number;
  ad_impr14: number;
  ad_clicks14: number;
  ad_orders14: number;
  views: number | null;
  rating: number | null;
  comments: number | null;
  cls: ProductClass;
  cls_source: string | null;
  suggested_cls: ProductClass | null;
  suggest_reason: string | null;
  problems: string[];
  upgrades: string[];
  updated_at: string;
}

async function load(shopId: number): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < 5; page++) {
    const { data, error } = await db()
      .from("product_lifecycle")
      .select("*")
      .eq("shop_id", shopId)
      .order("units30", { ascending: false })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }
  return out.map((r) => ({ ...r, price: r.price == null ? null : Number(r.price), profit_pct: r.profit_pct == null ? null : Number(r.profit_pct), breakeven: r.breakeven == null ? null : Number(r.breakeven), rating: r.rating == null ? null : Number(r.rating), ad_spend14: Number(r.ad_spend14), ad_gmv14: Number(r.ad_gmv14), ad_impr14: Number(r.ad_impr14), ad_clicks14: Number(r.ad_clicks14) }));
}

function ClassForm({ r, back, cls, label, primary }: { r: Row; back: string; cls: ProductClass; label: string; primary?: boolean }) {
  return (
    <form method="post" action="/api/admin/actions" style={{ display: "inline" }}>
      <input type="hidden" name="op" value="item_class" />
      <input type="hidden" name="shop_id" value={r.shop_id} />
      <input type="hidden" name="item_id" value={r.item_id} />
      <input type="hidden" name="class" value={cls} />
      <input type="hidden" name="back" value={back} />
      <button type="submit" className={primary ? undefined : "secondary"} style={{ padding: "3px 9px", fontSize: 12, margin: "2px 4px 2px 0", border: "1px solid var(--border)" }}>
        {label}
      </button>
    </form>
  );
}

export default async function Lifecycle({ searchParams }: { searchParams: Promise<{ msg?: string; shop?: string; view?: string }> }) {
  const sp = await searchParams;
  const shopList = shops();
  const shop = shopList.find((s) => String(s.shopId) === sp.shop) ?? shopList[0];
  const view = VIEWS.some((v) => v.key === sp.view) ? sp.view! : "de_xuat";
  const rows = await load(shop.shopId);
  const back = `/admin/lifecycle?shop=${shop.shopId}&view=${view}`;
  const count = (k: string) => (k === "all" ? rows.length : k === "de_xuat" ? rows.filter((r) => r.suggested_cls).length : rows.filter((r) => r.cls === k).length);
  const shown = rows
    .filter((r) => (view === "all" ? true : view === "de_xuat" ? !!r.suggested_cls : r.cls === view))
    .slice(0, 300);
  const updated = rows.length ? new Date(rows.map((r) => r.updated_at).sort().at(-1)!).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : null;

  return (
    <>
      <h1>Vòng đời sản phẩm</h1>
      <p className="muted">
        Mọi mã đang bán xếp theo ma trận BCG: <b>Dấu hỏi</b> (hàng mới, mã chưa chạy quảng cáo) · <b>Ngôi sao</b> (bán nhanh, lãi tốt) ·{" "}
        <b>Bò sữa</b> (chạy đều, lãi cao) · <b>Chó</b> (trái mùa, tồn nhiều). Tool đề xuất chuyển nhóm cả hai chiều và chẩn đoán phễu
        (xem → click → mua → lãi) để gợi ý nâng cấp. Cập nhật 6h40 sáng thứ Hai{updated ? `; lần gần nhất ${updated}` : ""}.
      </p>
      <p className="muted">
        <b>Lãi %</b> trên doanh thu thực nhận: <i>QC</i> = lãi thật khi chạy quảng cáo 14 ngày (D-15…D-2); <i>tiềm năng</i> = lãi trước
        quảng cáo (chưa đủ chi QC). Số quảng cáo chỉ tính chiến dịch một sản phẩm.
      </p>
      {sp.msg ? <p className="warning">{sp.msg}</p> : null}

      <div className="filters" style={{ marginBottom: 8 }}>
        {shopList.map((s) => (
          <a key={s.shopId} href={`/admin/lifecycle?shop=${s.shopId}&view=${view}`} style={s.shopId === shop.shopId ? { fontWeight: 700, borderColor: "var(--fg)" } : undefined}>
            {s.name}
          </a>
        ))}
      </div>
      <div className="filters">
        {VIEWS.map((v) => (
          <a key={v.key} href={`/admin/lifecycle?shop=${shop.shopId}&view=${v.key}`} style={v.key === view ? { fontWeight: 700, borderColor: "var(--fg)" } : undefined}>
            {v.label} ({count(v.key)})
          </a>
        ))}
      </div>

      <section className="card">
        <form method="post" action="/api/admin/actions" style={{ marginBottom: 8 }}>
          <input type="hidden" name="op" value="lifecycle" />
          <input type="hidden" name="shop_id" value={shop.shopId} />
          <input type="hidden" name="back" value={back} />
          <button type="submit" className="secondary" style={{ padding: "4px 10px", fontSize: 13, margin: 0, border: "1px solid var(--border)" }}>
            Chấm lại ngay
          </button>{" "}
          <span className="muted">Mất khoảng 1–3 phút.</span>
        </form>
        {rows.length === 0 ? (
          <p className="muted">Chưa có số liệu. Bấm “Chấm lại ngay”.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="l">Sản phẩm</th>
                  <th className="l">Nhóm</th>
                  <th className="l">Đề xuất</th>
                  <th title="Đơn vị bán trên Shopee (đơn không hủy)">Bán 7 / 30 ngày</th>
                  <th title="Tồn Pancake (hoặc Shopee) và số ngày đủ bán">Tồn</th>
                  <th title="Giá bán TB · giá vốn % · ROAS hòa vốn">Giá · vốn · hòa vốn</th>
                  <th>Lãi %</th>
                  <th title="Quảng cáo 14 ngày D-15…D-2: chi, ROAS, CTR, chuyển đổi">QC 14 ngày</th>
                  <th title="Lượt xem (Shopee), sao, số đánh giá">Xem · sao</th>
                  <th className="l">Vấn đề → nâng cấp</th>
                  <th className="l">Chọn nhóm</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const roas = r.ad_spend14 > 0 ? r.ad_gmv14 / r.ad_spend14 : null;
                  const ctr = r.ad_impr14 > 0 ? r.ad_clicks14 / r.ad_impr14 : null;
                  const cr = r.ad_clicks14 > 0 ? r.ad_orders14 / r.ad_clicks14 : null;
                  return (
                    <tr key={r.item_id}>
                      <td className="l" style={{ whiteSpace: "normal", minWidth: 260 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          {r.image ? <img src={`${r.image}_tn`} alt="" width={48} height={64} style={{ objectFit: "cover", borderRadius: 4, flex: "none" }} /> : null}
                          <span>
                            {r.name}
                            <br />
                            <span className="muted">{r.item_id}{r.in_ads ? " · đang chạy QC" : ""}</span>
                          </span>
                        </div>
                      </td>
                      <td className="l">
                        <span className={`tag cls-${r.cls}`}>{CLASS_VI[r.cls]}</span>
                        <br />
                        <span className="muted">{CLASS_BCG[r.cls]} · {SOURCE_VI[r.cls_source ?? ""] ?? ""}</span>
                      </td>
                      <td className="l" style={{ whiteSpace: "normal", minWidth: 200 }}>
                        {r.suggested_cls ? (
                          <>
                            <span className={`tag cls-${r.suggested_cls}`}>→ {CLASS_VI[r.suggested_cls]}</span>
                            <br />
                            <span className="muted">{r.suggest_reason?.split(": ").slice(1).join(": ")}</span>
                          </>
                        ) : (
                          <span className="muted">giữ</span>
                        )}
                      </td>
                      <td>{r.units7} / {r.units30}</td>
                      <td>
                        {r.stock ?? "—"}
                        <br />
                        <span className="muted">{r.days_of_stock == null ? "" : r.days_of_stock >= 9999 ? "không bán" : `${r.days_of_stock} ngày`}</span>
                      </td>
                      <td>
                        {r.price ? vnd(r.price) : "—"}
                        <br />
                        <span className="muted">{r.cost_ratio != null ? `${Math.round(r.cost_ratio * 100)}%` : "chưa có vốn"}{r.breakeven ? ` · ${r.breakeven}` : ""}</span>
                      </td>
                      <td className={r.profit_pct != null && r.profit_pct < 0 ? "neg" : undefined}>
                        {r.profit_pct == null ? "—" : `${r.profit_pct.toFixed(0)}%`}
                        <br />
                        <span className="muted">{r.profit_source === "qc" ? "QC" : r.profit_source === "tiem_nang" ? "tiềm năng" : ""}</span>
                      </td>
                      <td>
                        {r.ad_spend14 > 0 ? (
                          <>
                            {vnd(r.ad_spend14)} · ROAS {roas!.toFixed(1)}
                            <br />
                            <span className="muted">
                              CTR {ctr != null ? `${(ctr * 100).toFixed(1)}%` : "—"} · CĐ {cr != null ? `${(cr * 100).toFixed(1)}%` : "—"}
                            </span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {r.views ?? "—"}
                        <br />
                        <span className="muted">{r.rating ? `${r.rating.toFixed(1)}★ · ${r.comments ?? 0}` : ""}</span>
                      </td>
                      <td className="l" style={{ whiteSpace: "normal", minWidth: 240 }}>
                        {r.problems.length ? <div className="muted">{r.problems.join(" · ")}</div> : null}
                        {r.upgrades.length ? (
                          <div style={{ marginTop: 2 }}>
                            {r.upgrades.map((u) => (
                              <span key={u} className="tag" style={{ margin: "2px 4px 0 0" }}>{u}</span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                      <td className="l" style={{ whiteSpace: "normal", minWidth: 190 }}>
                        {r.suggested_cls ? <ClassForm r={r} back={back} cls={r.suggested_cls} label={`Nhận đề xuất: ${CLASS_VI[r.suggested_cls]}`} primary /> : null}
                        <div>
                          {CLASSES.filter((c) => c !== r.cls && c !== r.suggested_cls).map((c) => (
                            <ClassForm key={c} r={r} back={back} cls={c} label={CLASS_VI[c]} />
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {shown.length >= 300 ? <p className="muted">Đang hiện 300 mã đầu (bán nhiều nhất). Lọc theo nhóm để xem tiếp.</p> : null}
      </section>
    </>
  );
}
