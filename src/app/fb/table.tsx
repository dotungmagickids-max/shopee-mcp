"use client";

import { useMemo, useRef, useState } from "react";
import type { EvalRow, Level } from "@/lib/facebook/magic";

const vnd = (n: number | null) => (n == null ? "–" : Math.round(n).toLocaleString("vi-VN"));
const pct = (x: number | null) => (x == null ? "∞" : `${(x * 100).toFixed(1)}%`);
const SG: Record<string, string> = { pause: "Tắt", reduce: "Giảm", scale: "Scale", keep: "Giữ" };
const STATUS: Record<string, string> = { ACTIVE: "Đang chạy", PAUSED: "Tạm dừng", CAMPAIGN_PAUSED: "CD dừng", ADSET_PAUSED: "Nhóm dừng" };

type SortKey = "spendReal" | "messages" | "costPerMessage" | "orders" | "revenue" | "ratio" | "budget" | "stockDays";

/** Một thao tác ghi chờ xác nhận. Giai đoạn này chỉ hiện hộp "cũ → mới", không gọi Meta. */
type Pending = { title: string; target: string; from: string; to: string; money?: string };

export default function EvalTable({ rows, level }: { rows: EvalRow[]; level: Level }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "spendReal", desc: true });
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);

  const sorted = useMemo(() => {
    const v = (r: EvalRow) => {
      const x = r[sort.key];
      if (x == null) return sort.key === "ratio" ? Infinity : -Infinity;
      return x as number;
    };
    return [...rows].sort((a, b) => (sort.desc ? v(b) - v(a) : v(a) - v(b)));
  }, [rows, sort]);

  const tot = useMemo(() => {
    const spendReal = rows.reduce((s, r) => s + r.spendReal, 0);
    const spend = rows.reduce((s, r) => s + r.spend, 0);
    const messages = rows.reduce((s, r) => s + r.messages, 0);
    const orders = rows.reduce((s, r) => s + r.orders, 0);
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    return { spend, spendReal, messages, orders, revenue, cpm: messages ? spendReal / messages : null, ratio: revenue ? spendReal / revenue : null };
  }, [rows]);

  const open = (p: Pending) => {
    setDone(null);
    setPending(p);
    dlg.current?.showModal();
  };
  const budgetAct = (r: EvalRow, label: string, factor: number | "custom") => {
    if (!r.budget || !r.budget_id) return;
    let next: number;
    if (factor === "custom") {
      const s = window.prompt(`Ngân sách/ngày mới cho ${r.budget_level === "campaign" ? "chiến dịch" : "nhóm"} (đồng):`, String(r.budget));
      if (!s) return;
      next = Math.round(Number(s.replace(/[^\d]/g, "")) / 1000) * 1000;
      if (!next) return;
    } else next = Math.round((r.budget * factor) / 1000) * 1000;
    open({
      title: `Đổi ngân sách ${label}`,
      target: `${r.budget_level === "campaign" ? "Chiến dịch (CBO)" : "Nhóm"} ${r.budget_level === "campaign" ? r.campaign_name ?? "" : r.adset_name ?? ""} · ${r.budget_id}`,
      from: `${vnd(r.budget)}đ/ngày`,
      to: `${vnd(next)}đ/ngày`,
      money: `${next >= r.budget ? "+" : "−"}${vnd(Math.abs(next - r.budget))}đ/ngày (chi thật ~${vnd(Math.abs(next - r.budget) * 1.111)}đ)`,
    });
  };
  const toggle = (r: EvalRow) => {
    const on = r.status === "ACTIVE";
    open({ title: on ? "Tắt" : "Bật", target: `${r.name} · ${r.id}`, from: STATUS[r.status] ?? r.status, to: on ? "Tạm dừng" : "Đang chạy" });
  };
  const dup = (r: EvalRow, kind: string) => open({ title: kind, target: `${r.name} · ${r.id}`, from: r.account_name, to: "(chọn đích ở giai đoạn sau)" });

  const th = (key: SortKey, label: string) => (
    <th className="sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
      {label}
      {sort.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
    </th>
  );

  return (
    <div className="card">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="l">{level === "ad" ? "Quảng cáo" : level === "adset" ? "Nhóm quảng cáo" : "Chiến dịch"}</th>
              <th>Chi Meta</th>
              {th("spendReal", "Chi thật")}
              {th("messages", "Tin nhắn")}
              {th("costPerMessage", "Giá/tin")}
              {th("orders", "Đơn")}
              {th("revenue", "Doanh thu")}
              {th("ratio", "Chi/DT")}
              {th("budget", "NS/ngày")}
              {th("stockDays", "Hàng còn")}
              <th className="l">Gợi ý</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            <tr className="totals">
              <td className="l">Tổng {rows.length} dòng</td>
              <td>{vnd(tot.spend)}</td>
              <td>{vnd(tot.spendReal)}</td>
              <td>{vnd(tot.messages)}</td>
              <td>{vnd(tot.cpm)}</td>
              <td>{vnd(tot.orders)}</td>
              <td>{vnd(tot.revenue)}</td>
              <td>{pct(tot.ratio)}</td>
              <td colSpan={4} />
            </tr>
            {sorted.map((r) => (
              <tr key={r.id} className={`c-${r.color}`}>
                <td className="l">
                  <div>{r.name}</div>
                  <div className="sub">
                    {r.account_name}
                    {level !== "campaign" && r.campaign_name ? ` · ${r.campaign_name}` : ""}
                    {level === "ad" && r.adset_name ? ` / ${r.adset_name}` : ""}
                    {level !== "ad" ? ` · ${r.ads} QC` : ""}
                    {" · "}
                    <span className={`st-${r.status}`}>{STATUS[r.status] ?? (r.status || "?")}</span>
                    {r.codes.length ? ` · ${r.codes.join(", ")}` : ""}
                    {` · trần ${Math.round(r.ceiling.profit_ceiling * 100)}/${Math.round(r.ceiling.breakeven * 100)}%`}
                  </div>
                </td>
                <td>{vnd(r.spend)}</td>
                <td>{vnd(r.spendReal)}</td>
                <td>{vnd(r.messages)}</td>
                <td>{vnd(r.costPerMessage)}</td>
                <td>{r.orders}</td>
                <td>{vnd(r.revenue)}</td>
                <td className="ratio">{r.spendReal || r.revenue ? pct(r.ratio) : "–"}</td>
                <td title={r.budget_level === "campaign" ? "Ngân sách chiến dịch (CBO)" : r.budget_level === "adset" ? "Ngân sách nhóm (ABO)" : ""}>
                  {vnd(r.budget)}
                  {r.budget_level === "campaign" && level !== "campaign" ? <span className="sub"> CBO</span> : null}
                </td>
                <td className={r.stockDays != null && r.stockDays < 3 ? "low" : ""}>
                  {r.stockDays == null ? "–" : r.stockDays > 999 ? ">999" : `${Math.floor(r.stockDays)} ngày`}
                </td>
                <td className="l">
                  <span className={`sg sg-${r.suggestion.action}`}>{SG[r.suggestion.action]}</span>{" "}
                  <span className="sub">{r.suggestion.reason}</span>
                </td>
                <td>
                  <div className="acts">
                    <button type="button" className="secondary" onClick={() => toggle(r)}>{r.status === "ACTIVE" ? "Tắt" : "Bật"}</button>
                    {r.budget ? (
                      <>
                        <button type="button" className="secondary" onClick={() => budgetAct(r, "+20%", 1.2)}>+20%</button>
                        <button type="button" className="secondary" onClick={() => budgetAct(r, "+30%", 1.3)}>+30%</button>
                        <button type="button" className="secondary" onClick={() => budgetAct(r, "−30%", 0.7)}>−30%</button>
                        <button type="button" className="secondary" onClick={() => budgetAct(r, "(nhập số)", "custom")}>Số…</button>
                      </>
                    ) : null}
                    {level !== "campaign" ? (
                      <>
                        <button type="button" className="secondary" onClick={() => dup(r, "Nhân bản sang tài khoản khác")}>Nhân bản</button>
                        <button type="button" className="secondary" onClick={() => dup(r, "Nhân bản sang nhóm tuổi khác")}>Tuổi</button>
                        <button type="button" className="secondary" onClick={() => dup(r, "Gộp vào CBO")}>CBO</button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dialog ref={dlg} onClose={() => setPending(null)}>
        {pending ? (
          <>
            <h2>{pending.title}</h2>
            <p className="sub">{pending.target}</p>
            <p className="change">
              {pending.from} → <b>{pending.to}</b>
            </p>
            {pending.money ? <p>{pending.money}</p> : null}
            {done ? (
              <p className="warnbox">{done}</p>
            ) : (
              <p className="warnbox">Giai đoạn đánh giá chỉ đọc: bấm xác nhận sẽ <b>chưa</b> gọi lệnh ghi lên Meta.</p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {!done ? (
                <button type="button" onClick={() => setDone("Chưa gửi lên Meta. Lệnh ghi sẽ bật ở giai đoạn sau, sau khi anh duyệt.")}>
                  Xác nhận
                </button>
              ) : null}
              <button type="button" className="secondary" onClick={() => dlg.current?.close()}>
                Đóng
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </div>
  );
}
