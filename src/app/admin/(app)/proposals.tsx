import { pendingProposals } from "@/lib/autopilot/dashboard";
import { shopName } from "@/lib/autopilot/config";
import { vnd } from "@/lib/autopilot/telegram";

function change(action: string, before: any, after: any): string {
  if (action === "change_budget") return `Ngân sách ${before?.budget === 0 ? "không giới hạn" : vnd(before?.budget)} → ${vnd(after?.budget)}`;
  if (action === "change_roas_target") return `ROAS mục tiêu ${before?.roas_target ?? "-"} → ${after?.roas_target}`;
  if (action === "pause") return `Tạm dừng${after?.until_midnight ? " tới 0h" : ""}`;
  if (action === "resume") return "Bật lại";
  if (action === "refresh") return `Làm mới: dừng hẳn, tạo chiến dịch mới NS ${vnd(after?.budget)}, ROAS ${after?.roas_target ?? "-"}`;
  return action;
}

function DecideButtons({ id, back }: { id: number; back: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <form method="post" action="/api/admin/actions">
        <input type="hidden" name="op" value="decide" />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="approve" value="1" />
        <input type="hidden" name="back" value={back} />
        <button type="submit" style={{ padding: "4px 10px", fontSize: 13 }}>Đồng ý</button>
      </form>
      <form method="post" action="/api/admin/actions">
        <input type="hidden" name="op" value="decide" />
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="approve" value="0" />
        <input type="hidden" name="back" value={back} />
        <button type="submit" className="secondary" style={{ padding: "4px 10px", fontSize: 13, margin: 0 }}>Bỏ qua</button>
      </form>
    </span>
  );
}

/** Danh sách đề xuất đang chờ duyệt, kèm nút Đồng ý / Bỏ qua. */
export async function Proposals({ back = "/admin" }: { back?: string }) {
  const rows = await pendingProposals();
  return (
    <section className="card">
      <h2>Đề xuất chờ duyệt {rows.length ? <span className="tag">{rows.length}</span> : null}</h2>
      {rows.length === 0 ? (
        <p className="muted">Không có đề xuất nào. Luật chạy mỗi 15 phút sau khi thu số liệu.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="l">
                    <b>{shopName(Number(r.shop_id))}</b> <span className="muted">({r.shop_id})</span>
                    <br />
                    {r.action === "group" ? (
                      <details>
                        <summary>{r.after?.title} — {r.children.length} chiến dịch</summary>
                        <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                          {r.children.map((c: any) => (
                            <li key={c.id}>
                              {c.name} <span className="muted">#{c.campaign_id}</span>: {change(c.action, c.before, c.after)}
                              {c.after?.why ? <span className="muted"> — {c.after.why}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <>
                        {r.name} <span className="muted">#{r.campaign_id}</span>
                        <br />
                        <b>{change(r.action, r.before, r.after)}</b>
                      </>
                    )}
                    <div className="muted">{r.reason}</div>
                    <div className="muted">
                      {r.source} · hết hạn{" "}
                      {new Date(r.expires_at).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </td>
                  <td>
                    <DecideButtons id={r.id} back={back} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
