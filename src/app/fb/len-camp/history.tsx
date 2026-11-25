"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { HistoryRun } from "@/lib/facebook/launch-data";
import { adsManagerAd, adsManagerAdset, canRetry, type RunResult } from "@/lib/facebook/launch-history";

type Props = { runs: HistoryRun[]; accounts: { id: string; name: string }[]; pages: Record<string, string>; tableReady: boolean; error: string | null };

const when = (iso: string) =>
  new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

/** Lịch sử lên camp: mỗi lần bấm Tạo, kết quả từng quảng cáo, nút mở Trình quản lý quảng cáo và nút tạo lại bài lỗi. */
export default function History({ runs, accounts, pages, tableReady, error }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  const retry = async (run: HistoryRun, index: number, r: RunResult) => {
    const key = `${run.kind === "saved" ? run.id : run.key}:${index}`;
    if (!confirm(`Tạo lại quảng cáo ${r.ad_name} vào nhóm ${r.adset_name ?? r.adset_id} (${accName(r.account_id)})?\nQuảng cáo tạo ở trạng thái tạm dừng.`)) return;
    setBusy(key);
    try {
      const res = await fetch("/api/fb/launch-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, index, ...(run.kind === "saved" ? { run_id: run.id } : { log: run.key }) }),
      });
      const body = await res.json().catch(() => null);
      setMsg((m) => ({ ...m, [key]: !res.ok ? `Chưa tạo được: ${body?.error ?? res.status}` : body?.result?.ad_id ? `Đã tạo QC ${body.result.ad_id}` : `Vẫn lỗi: ${body?.result?.error ?? ""}` }));
      router.refresh();
    } catch {
      setMsg((m) => ({ ...m, [key]: "Không gọi được máy chủ. Kiểm tra Trình quản lý quảng cáo trước khi bấm lại, tránh tạo trùng." }));
    }
    setBusy(null);
  };

  return (
    <div className="card" id="lich-su">
      <h2 style={{ marginTop: 0 }}>Lịch sử lên camp (14 ngày)</h2>
      <p className="sub">
        Mỗi lần bấm Tạo đều được lưu ở đây, tải lại trang không mất. Dòng lỗi có nhóm sẵn thì bấm <b>Tạo lại</b> để tạo quảng cáo vào đúng nhóm đó (vẫn tạm
        dừng). Quảng cáo tạo được: vào Trình quản lý quảng cáo, bấm Chọn bài viết → Tiếp tục, rồi chọn mẫu chào ở tab Mẫu đã lưu.
        {!tableReady ? " Chưa áp migration bảng lưu: đang dựng lại từ nhật ký lệnh ghi, tạo lại chưa dùng được." : ""}
      </p>
      {error ? <p className="error">{error}</p> : null}
      {!runs.length ? <p className="sub">Chưa có lần lên camp nào trong 14 ngày.</p> : null}
      {runs.map((run) => {
        const rid = run.kind === "saved" ? String(run.id) : run.key;
        const start = run.kind === "saved" ? run.created_at : run.started_at;
        const ok = run.results.filter((r) => r.ad_id).length;
        const camps = [...new Set(run.results.map((r) => r.campaign_name).filter(Boolean))].join(", ");
        return (
          <details key={rid} open={runs[0] === run || ok < run.results.length} style={{ marginBottom: 10 }}>
            <summary>
              <b>{when(start)}</b> · {run.page_id ? pages[run.page_id] ?? run.page_id : "page chưa rõ"}
              {camps ? ` · ${camps}` : ""} · tạo được{" "}
              <b className={ok < run.results.length ? "low" : "ok"}>
                {ok}/{run.results.length}
              </b>{" "}
              quảng cáo
              {run.kind === "saved" && run.status === "dang_chay" ? " · đang chạy hoặc bị ngắt giữa chừng" : ""}
              {run.kind === "log" || run.source === "nhat_ky" ? " · dựng lại từ nhật ký" : ""}
            </summary>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="l">Quảng cáo</th>
                    <th className="l">Tài khoản · nhóm</th>
                    <th className="l">Kết quả</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {run.results.map((r, i) => {
                    const key = `${rid}:${i}`;
                    return (
                      <tr key={key}>
                        <td className="l">
                          {r.ad_name}
                          {r.post_id ? <div className="sub">bài {r.post_id.split("_")[1]}</div> : null}
                        </td>
                        <td className="l">
                          {accName(r.account_id)}
                          {r.adset_id ? (
                            <div className="sub">
                              <a href={adsManagerAdset(r)} target="_blank" rel="noreferrer">
                                nhóm {r.adset_name ?? r.adset_id}
                              </a>
                            </div>
                          ) : null}
                        </td>
                        <td className="l">
                          {r.ad_id ? (
                            <span className="ok">
                              Đã tạo ·{" "}
                              <a href={adsManagerAd(r)} target="_blank" rel="noreferrer">
                                mở QC {r.ad_id}
                              </a>
                              {r.notes?.length ? <span className="low"> · {r.notes.join(" ")}</span> : null}
                            </span>
                          ) : (
                            <span className="low">Lỗi: {r.error ?? "không rõ"}</span>
                          )}
                          {msg[key] ? <div className="sub">{msg[key]}</div> : null}
                        </td>
                        <td>
                          {canRetry(r) && tableReady ? (
                            <button type="button" className="secondary" disabled={busy !== null} onClick={() => retry(run, i, r)}>
                              {busy === key ? "Đang tạo…" : "Tạo lại"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}
