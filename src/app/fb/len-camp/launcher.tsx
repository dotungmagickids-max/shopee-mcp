"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildPlan, MAX_ITEMS, nextName, pageShort, planBudget, suggestAdsetName, suggestCampaignName, validate, welcomeTemplate, type LaunchConfig, type LaunchItem, type Shape } from "@/lib/facebook/launch";
import type { LaunchDraft, LaunchResult, PostRow } from "@/lib/facebook/launch-data";

const vnd = (n: number | null | undefined) => (n == null ? "–" : Math.round(n).toLocaleString("vi-VN"));
const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }) : "");
/** Ngưỡng lọc theo tốc độ bán (chiếc/ngày, mọi kênh). */
const HOT = 5;
const STEADY = 1;

type Props = { pageId: string; pageName: string; posts: PostRow[]; accounts: { id: string; name: string }[]; usedNames: string[]; usedCampaigns?: string[]; drafts?: LaunchDraft[] | null; preselect?: string[]; openDraftId?: number };

const SHAPES: [Shape, string][] = [
  ["1-1-n", "1-1-N: 1 chiến dịch, 1 nhóm, mỗi bài 1 quảng cáo (test)"],
  ["1-n-1", "1-N-1: 1 chiến dịch, mỗi bài 1 nhóm (scale)"],
  ["n-1-1", "N-1-1: mỗi bài 1 chiến dịch riêng"],
];

export default function Launcher({ pageId, pageName, posts, accounts, usedNames, usedCampaigns = [], drafts: savedDrafts = null, preselect = [], openDraftId }: Props) {
  const [drafts, setDrafts] = useState<LaunchDraft[]>(savedDrafts ?? []);
  const [startTime, setStartTime] = useState("");
  const [draftMsg, setDraftMsg] = useState<string | null>(null);
  // Bài chọn sẵn từ màn Bài đã đăng; bài nào không còn trong 30 ngày gần nhất thì bỏ qua và báo số lượng.
  const preFound = useMemo(() => preselect.filter((id) => posts.some((p) => p.id === id)).slice(0, MAX_ITEMS), [preselect, posts]);
  const [picked, setPicked] = useState<string[]>(preFound);
  const [onlyNew, setOnlyNew] = useState(false);
  const [onlyStock, setOnlyStock] = useState(false);
  const [speed, setSpeed] = useState<"" | "hot" | "steady">("");
  const [q, setQ] = useState("");
  const [accs, setAccs] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [structure, setStructure] = useState<"abo" | "cbo">("abo");
  const [shape, setShape] = useState<Shape>("1-1-n");
  /** Tên anh tự gõ; null = dùng tên máy gợi ý (tự đổi theo bài đã chọn và cấu hình). */
  const [adsetTyped, setAdsetTyped] = useState<string | null>(null);
  const [campTyped, setCampTyped] = useState<string | null>(null);
  const [ageMin, setAgeMin] = useState("25");
  const [ageMax, setAgeMax] = useState("45");
  const [gender, setGender] = useState<"all" | "female" | "male">("female");
  const [placement, setPlacement] = useState<"auto" | "facebook">("auto");
  const [items, setItems] = useState<LaunchItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<LaunchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);

  const shown = useMemo(() => {
    const code = q.trim().toUpperCase();
    return posts.filter(
      (p) =>
        (!onlyNew || !p.ran) &&
        (!onlyStock || (p.stockDays != null && p.stockDays >= 3)) &&
        (!speed || (p.rate != null && (speed === "hot" ? p.rate >= HOT : p.rate >= STEADY && p.rate < HOT))) &&
        (!code || p.codes.some((c) => c.includes(code)))
    );
  }, [posts, onlyNew, onlyStock, speed, q]);

  const grouped = shape !== "n-1-1";
  const pickedCodes = useMemo(() => [...new Set(picked.flatMap((id) => posts.find((p) => p.id === id)?.codes ?? []))], [picked, posts]);
  const campSuggest = useMemo(() => suggestCampaignName(pageShort(pageName), pickedCodes, usedCampaigns), [pageName, pickedCodes, usedCampaigns]);
  const adsetSuggest = suggestAdsetName({ gender, age_min: Number(ageMin), age_max: Number(ageMax), placement });
  const campName = campTyped ?? campSuggest;
  const adsetName = adsetTyped ?? adsetSuggest;
  const cfg: LaunchConfig = {
    page_id: pageId,
    accounts: accs,
    budget: Number(budget.replace(/[^\d]/g, "")),
    structure: grouped ? structure : "abo",
    shape,
    age_min: Number(ageMin),
    age_max: Number(ageMax),
    gender,
    placement,
    cbo_name: grouped ? campName : undefined,
    adset_name: adsetName,
    start_time: startTime || undefined,
  };
  const budgetHint = !grouped ? "Ngân sách/ngày mỗi bài (đ)" : structure === "cbo" ? "Ngân sách/ngày cả chiến dịch (đ)" : shape === "1-1-n" ? "Ngân sách/ngày của nhóm (đ)" : "Ngân sách/ngày mỗi nhóm (đ)";
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const preview = () => {
    setResults(null);
    const used = [...usedNames];
    const list = picked.map((id) => {
      const p = posts.find((x) => x.id === id)!;
      const name = nextName(p.codes, used);
      used.push(name);
      return { post_id: id, name };
    });
    const bad = validate(cfg, list);
    setError(bad);
    setItems(bad ? null : list);
  };

  /** Lưu kế hoạch đang xem trước thành nháp: chỉ ghi vào máy chủ của mình, không gọi Meta. */
  const saveDraft = async () => {
    if (!items) return;
    setDraftMsg(null);
    try {
      const res = await fetch("/api/fb/launch-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: grouped ? campName : `${items[0].name}${items.length > 1 ? ` +${items.length - 1}` : ""}`, config: cfg, items }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.draft) return setDraftMsg(body?.error ?? `Chưa lưu được (lỗi ${res.status}).`);
      setDrafts((xs) => [body.draft, ...xs]);
      setDraftMsg("Đã lưu nháp. Chưa tạo gì trên Meta.");
    } catch {
      setDraftMsg("Chưa lưu được, anh thử lại.");
    }
  };
  const openDraft = (d: LaunchDraft) => {
    const c = d.config ?? {};
    const have = d.items.filter((i) => posts.some((p) => p.id === i.post_id));
    setPicked(have.map((i) => i.post_id));
    setAccs((c.accounts ?? []).filter((a) => accounts.some((x) => x.id === a)));
    setBudget(c.budget ? String(c.budget) : "");
    setStructure(c.structure === "cbo" ? "cbo" : "abo");
    setShape(c.shape ?? (c.structure === "cbo" ? "1-n-1" : "n-1-1"));
    setAgeMin(String(c.age_min ?? 25));
    setAgeMax(String(c.age_max ?? 45));
    setGender(c.gender ?? "female");
    setPlacement(c.placement ?? "auto");
    setCampTyped(c.cbo_name ?? null);
    setAdsetTyped(c.adset_name ?? null);
    setStartTime(c.start_time ?? "");
    setResults(null);
    setItems(null);
    setError(have.length < d.items.length ? `Nháp có ${d.items.length} bài, chỉ còn ${have.length} bài nằm trong 30 ngày gần nhất.` : null);
    setDraftMsg(`Đã mở nháp "${d.name}". Bấm Xem trước để kiểm lại rồi mới tạo.`);
  };
  // Mở sẵn nháp khi đến từ nút Sửa ở màn Mục tiêu (một lần, lúc vào trang).
  useEffect(() => {
    const d = openDraftId ? drafts.find((x) => x.id === openDraftId) : undefined;
    if (d) openDraft(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDraftId]);

  const removeDraft = async (d: LaunchDraft) => {
    if (!window.confirm(`Xóa nháp "${d.name}"?`)) return;
    const res = await fetch("/api/fb/launch-drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: d.id }) }).catch(() => null);
    if (res?.ok) setDrafts((xs) => xs.filter((x) => x.id !== d.id));
    else setDraftMsg("Chưa xóa được nháp.");
  };

  const plan = items ? buildPlan(cfg, items) : [];
  const total = planBudget(plan);

  const create = async () => {
    if (!items) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fb/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: true, config: cfg, items }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.results) setError(body?.error ?? `Lỗi ${res.status}`);
      else {
        setResults(body.results);
        setItems(null);
        setPicked([]);
      }
    } catch {
      setError("Không gọi được máy chủ. Kiểm tra trong Trình quản lý quảng cáo trước khi tạo lại, tránh tạo trùng.");
    }
    setBusy(false);
    dlg.current?.close();
  };

  return (
    <>
      {drafts.length ? (
        <div className="card">
          <h2>Nháp đã lưu ({drafts.length})</h2>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {drafts.map((d) => (
                  <tr key={d.id}>
                    <td className="l">{d.name}</td>
                    <td>{d.items.length} bài</td>
                    <td>{d.config?.budget ? `${vnd(d.config.budget)}đ/ngày` : "–"}</td>
                    <td>{d.config?.start_time ? `hẹn ${d.config.start_time.replace("T", " ")}` : "chạy khi bật"}</td>
                    <td>{day(d.created_at)}</td>
                    <td>
                      <span className="acts">
                        <button type="button" onClick={() => openDraft(d)}>Mở</button>
                        <button type="button" className="secondary" onClick={() => removeDraft(d)}>Xóa</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {draftMsg ? <p className="sub" style={{ margin: "8px 4px" }}>{draftMsg}</p> : null}

      <div className="card">
        <h2>1. Chọn bài ({picked.length} đã chọn, tối đa {MAX_ITEMS})</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <label><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Bài chưa chạy</label>
          <label><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Hàng còn từ 3 ngày</label>
          <select value={speed} onChange={(e) => setSpeed(e.target.value as typeof speed)}>
            <option value="">Mọi tốc độ bán</option>
            <option value="hot">Mã hot (từ {HOT} chiếc/ngày)</option>
            <option value="steady">Bán đều ({STEADY}–{HOT} chiếc/ngày)</option>
          </select>
          <input placeholder="Mã SP" value={q} onChange={(e) => setQ(e.target.value)} size={12} />
          <span className="sub">{shown.length}/{posts.length} bài</span>
        </div>
        {preselect.length ? (
          <p className="sub" style={{ marginBottom: 8 }}>
            Đã chọn sẵn {preFound.length}/{preselect.length} bài từ màn Bài đã đăng
            {preFound.length < preselect.length ? " (bài còn lại không nằm trong 30 ngày gần nhất hoặc là bài ngoài tường)" : ""}.
          </p>
        ) : null}
        <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
          <table className="data">
            <thead>
              <tr>
                <th />
                <th className="l">Bài</th>
                <th>Ngày</th>
                <th className="l">Mã</th>
                <th>Tồn</th>
                <th>Bán/ngày</th>
                <th>Hàng còn</th>
                <th className="l">Đã chạy (90 ngày)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td><input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} /></td>
                  <td className="l">
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {p.picture ? <img src={p.picture} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} loading="lazy" /> : null}
                      <div>
                        <div>{p.message.slice(0, 90) || "(không có chữ)"}</div>
                        <div className="sub">
                          {/video/i.test(p.kind) ? "Video/reel" : "Bài"}
                          {p.permalink ? <> · <a href={p.permalink} target="_blank" rel="noreferrer">mở bài</a></> : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{day(p.created_time)}</td>
                  <td className="l">{p.codes.join(", ") || <span className="low">không thấy mã</span>}</td>
                  <td>{vnd(p.stock)}</td>
                  <td>{p.rate == null ? "–" : p.rate.toFixed(1)}</td>
                  <td className={p.stockDays != null && p.stockDays < 3 ? "low" : ""}>{p.stockDays == null ? "–" : `${Math.floor(Math.min(p.stockDays, 999))} ngày`}</td>
                  <td className="l">
                    {p.ran ? (
                      <>
                        {p.ran.ads} QC · chi {vnd(p.ran.spendReal)} · {p.ran.orders} đơn · {vnd(p.ran.revenue)}
                        {p.ran.revenue > 0 ? ` → ${Math.round((p.ran.spendReal / p.ran.revenue) * 100)}%` : ""}
                      </>
                    ) : (
                      <span className="sub">chưa chạy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>2. Cấu hình chung</h2>
        <p className="sub">Page: <b>{pageName}</b> · Mục tiêu: tin nhắn Messenger (CTX) · Việt Nam</p>
        <div className="filters" style={{ margin: "8px 0" }}>
          {accounts.map((a) => (
            <label key={a.id}>
              <input type="checkbox" checked={accs.includes(a.id)} onChange={() => setAccs((x) => (x.includes(a.id) ? x.filter((y) => y !== a.id) : [...x, a.id]))} /> {a.name}
            </label>
          ))}
        </div>
        <p className="sub">Chọn nhiều tài khoản thì bài được chia đều lần lượt.</p>
        <div className="filters" style={{ marginTop: 8 }}>
          <select value={shape} onChange={(e) => setShape(e.target.value as Shape)} aria-label="Cấu trúc camp">
            {SHAPES.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          {grouped ? (
            <select value={structure} onChange={(e) => setStructure(e.target.value as "abo" | "cbo")} aria-label="Kiểu ngân sách">
              <option value="abo">ABO: ngân sách ở nhóm</option>
              <option value="cbo">CBO: ngân sách ở chiến dịch</option>
            </select>
          ) : null}
          <input placeholder={budgetHint} title={budgetHint} value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="numeric" size={26} />
          <span>Tuổi</span>
          <input value={ageMin} onChange={(e) => setAgeMin(e.target.value)} size={3} inputMode="numeric" />
          <span>–</span>
          <input value={ageMax} onChange={(e) => setAgeMax(e.target.value)} size={3} inputMode="numeric" />
          <select value={gender} onChange={(e) => setGender(e.target.value as typeof gender)}>
            <option value="all">Nam và nữ</option>
            <option value="female">Nữ</option>
            <option value="male">Nam</option>
          </select>
          <select value={placement} onChange={(e) => setPlacement(e.target.value as typeof placement)}>
            <option value="auto">Vị trí tự động</option>
            <option value="facebook">Chỉ Facebook</option>
          </select>
        </div>
        <div className="filters" style={{ marginTop: 8 }}>
          {grouped ? (
            <label className="named">
              <span className="sub">Tên chiến dịch {campTyped == null ? "(máy gợi ý)" : "(anh sửa)"}</span>
              <input value={campName} onChange={(e) => setCampTyped(e.target.value)} size={34} />
            </label>
          ) : (
            <span className="sub">Tên chiến dịch: lấy theo tên quảng cáo của từng bài.</span>
          )}
          <label className="named">
            <span className="sub">Tên nhóm {adsetTyped == null ? "(máy gợi ý)" : "(anh sửa)"}{shape === "1-n-1" ? ", tự thêm -01, -02…" : ""}</span>
            <input value={adsetName} onChange={(e) => setAdsetTyped(e.target.value)} size={26} />
          </label>
          {campTyped != null || adsetTyped != null ? (
            <button type="button" className="secondary" onClick={() => { setCampTyped(null); setAdsetTyped(null); }}>Dùng lại tên gợi ý</button>
          ) : null}
          <label className="named">
            <span className="sub">Hẹn giờ bắt đầu chạy (để trống = chạy ngay khi bật)</span>
            <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <button type="button" onClick={preview}>Xem trước</button>
        </div>
        <p className="sub" style={{ marginTop: 6 }}>
          Tên gợi ý theo quy ước: chiến dịch TT-page-mã-số thứ tự (số kế tiếp sau chiến dịch đã chạy 90 ngày), nhóm TN-tệp-kiểu nhắm, quảng cáo MÃ-Pxx-Vxx. Sửa được hết ở đây và ở bước xem trước.
        </p>
        {error ? <p className="error">{error}</p> : null}
      </div>

      {items ? (
        <div className="card">
          <h2>3. Xem trước</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="l">Tên quảng cáo (sửa được)</th>
                  <th className="l">Tài khoản</th>
                  <th className="l">Chiến dịch</th>
                  <th className="l">Nhóm</th>
                  <th>Ngân sách/ngày</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {plan.flatMap((c) =>
                  c.adsets.flatMap((set, i) =>
                    set.ads.map((a, j) => (
                    <tr key={a.post_id}>
                      <td className="l">
                        <input
                          value={items.find((x) => x.post_id === a.post_id)?.name ?? ""}
                          onChange={(e) => setItems((xs) => xs!.map((x) => (x.post_id === a.post_id ? { ...x, name: e.target.value } : x)))}
                          size={34}
                        />
                      </td>
                      <td className="l">{accName(c.account_id)}</td>
                      <td className="l">{c.name}</td>
                      <td className="l">{set.name}</td>
                      <td>{set.daily_budget ? (j === 0 ? vnd(set.daily_budget) : "↑ chung nhóm") : i === 0 && j === 0 ? `${vnd(c.daily_budget)} (CBO)` : "↑ chung"}</td>
                      <td>Tạm dừng</td>
                    </tr>
                    ))
                  )
                )}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 10 }}>
            {items.length} quảng cáo · {plan.reduce((s, c) => s + c.adsets.length, 0)} nhóm · {plan.length} chiến dịch · tổng ngân sách <b>{vnd(total)}đ/ngày</b> (chi thật ~{vnd(total * 1.111)}đ) khi bật hết.
          </p>
          {startTime ? <p className="sub">Hẹn bắt đầu chạy: {startTime.replace("T", " ")} (giờ Việt Nam). Quảng cáo vẫn tạo tạm dừng; anh bật thì Meta chờ tới giờ này mới chạy.</p> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={() => dlg.current?.showModal()}>Tạo {items.length} quảng cáo (tạm dừng)</button>
            <button type="button" className="secondary" onClick={saveDraft}>Lưu nháp (chưa tạo trên Meta)</button>
          </div>
        </div>
      ) : null}

      {results ? (
        <div className="card">
          <h2>Kết quả</h2>
          <p>
            Tạo được {results.filter((r) => r.ad_id).length}/{results.length} quảng cáo, tất cả đang <b>tạm dừng</b>.
          </p>
          {results.some((r) => r.ad_id) ? (
            <div className="warnbox" style={{ marginBottom: 10 }}>
              <b>Trước khi bật, làm 2 việc trong Trình quản lý quảng cáo cho từng quảng cáo</b> (Meta không cho web làm thay với bài có sẵn):
              <br />
              1. Mục Cuộc trò chuyện: chọn tab Mẫu đã lưu, rồi chọn mẫu{" "}
              {welcomeTemplate(pageName) ? <b>{welcomeTemplate(pageName)}</b> : "chào chuẩn của page này (page này chưa có mẫu ghi sẵn trên web)"} (hỏi tuổi, cân nặng của bé; 1
              câu hỏi Tư vấn). Đừng để tab Mẫu nên dùng do AI tạo.
              <br />
              2. Mục Nguồn quảng cáo: kiểm đang <b>tắt</b> sản phẩm từ danh mục (web đã gửi lệnh tắt lúc tạo; dòng nào báo chưa tắt được thì anh tắt tay).
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="l">Quảng cáo</th>
                  <th className="l">Tài khoản</th>
                  <th className="l">Kết quả</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.post_id}>
                    <td className="l">{r.ad_name}</td>
                    <td className="l">{accName(r.account_id)}</td>
                    <td className="l">
                      {r.ad_id ? (
                        <span className="ok">
                          Đã tạo · QC {r.ad_id} ·{" "}
                          <a href={`https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${r.account_id}&selected_ad_ids=${r.ad_id}`} target="_blank" rel="noreferrer">
                            mở trong Trình quản lý quảng cáo
                          </a>
                          {r.notes?.length ? <span className="low"> · {r.notes.join(" ")}</span> : null}
                        </span>
                      ) : (
                        <span className="low">
                          Lỗi: {r.error}
                          {r.campaign_id ? ` (đã tạo dở: chiến dịch ${r.campaign_id}${r.adset_id ? `, nhóm ${r.adset_id}` : ""}, đang tạm dừng)` : ""}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <dialog ref={dlg}>
        <h2>Tạo quảng cáo trên Meta</h2>
        <p className="change">
          Chưa có → <b>{items?.length ?? 0} quảng cáo tạm dừng</b>
        </p>
        <p>
          {plan.length} chiến dịch trên {new Set(plan.map((c) => c.account_id)).size} tài khoản ({[...new Set(plan.map((c) => accName(c.account_id)))].join(", ")}).
          <br />
          Ngân sách đặt sẵn: {vnd(total)}đ/ngày (chi thật ~{vnd(total * 1.111)}đ). Chưa tiêu tiền cho tới khi anh bật.
        </p>
        <p className="warnbox">Bấm xác nhận là gửi lệnh tạo thật lên Meta. Không bấm lại khi đang chạy.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button type="button" disabled={busy} onClick={create}>{busy ? "Đang tạo…" : "Xác nhận tạo"}</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => dlg.current?.close()}>Hủy</button>
        </div>
      </dialog>
    </>
  );
}
