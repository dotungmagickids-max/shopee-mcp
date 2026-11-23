"use client";

import { useMemo, useState } from "react";
import { countByCode, countByPage, KIND_LABEL, matches, normCode, type ContentKind, type ContentPost } from "@/lib/facebook/content";

type PageInfo = { id: string; name: string; source: "meta" | "composio" | "pancake" | null; error: string | null };
const KINDS: [ContentKind | "", string][] = [
  ["", "Mọi loại"],
  ["video", "Video"],
  ["reel", "Reel"],
  ["photo", "Ảnh"],
];
const PER_PAGE = 60;
const fmtDay = (d: string | null) => (d ? d.split("-").reverse().slice(0, 2).join("/") : "–");

export default function Board({ posts, pages, initialCode, initialPage }: { posts: ContentPost[]; pages: PageInfo[]; initialCode: string; initialPage: string }) {
  const [page, setPage] = useState(pages.some((p) => p.id === initialPage) ? initialPage : "");
  const [code, setCode] = useState(normCode(initialCode));
  const [kind, setKind] = useState<ContentKind | "">("");
  const [noCode, setNoCode] = useState(false);
  const [scope, setScope] = useState<"wall" | "off">("wall");
  const [shown, setShown] = useState(PER_PAGE);
  const [copied, setCopied] = useState<string | null>(null);

  const names = useMemo(() => new Map(pages.map((p) => [p.id, p.name])), [pages]);
  // Số trên thẻ page: theo mã + loại đang lọc (không theo page đang chọn, để so các page với nhau).
  const counts = useMemo(
    () => countByPage(posts.filter((p) => matches(p, { code, kind, noCode, scope })), pages.map((p) => p.id)),
    [posts, pages, code, kind, noCode, scope]
  );
  // Danh sách mã: theo page + loại đang lọc.
  const codes = useMemo(() => countByCode(posts.filter((p) => matches(p, { page, kind, scope }))), [posts, page, kind, scope]);
  const offCount = useMemo(() => posts.filter((p) => p.offWall && (!page || p.page_id === page)).length, [posts, page]);
  const list = useMemo(() => posts.filter((p) => matches(p, { page, code, kind, noCode, scope })), [posts, page, code, kind, noCode, scope]);
  const total = counts.reduce((s, c) => s + c.total, 0);
  const reset = () => setShown(PER_PAGE);

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      window.prompt("ID bài:", id);
    }
  };

  return (
    <>
      <div className="pagecards">
        <button type="button" className={`pagecard${page === "" ? " on" : ""}`} onClick={() => { setPage(""); reset(); }}>
          <span className="pc-name">Tất cả page</span>
          <span className="pc-num">{total}</span>
          <span className="pc-sub">bài</span>
        </button>
        {pages.map((p) => {
          const c = counts.find((x) => x.page_id === p.id)!;
          return (
            <button type="button" key={p.id} className={`pagecard${page === p.id ? " on" : ""}${p.error ? " bad" : ""}`} onClick={() => { setPage(page === p.id ? "" : p.id); reset(); }}>
              <span className="pc-name">{p.name}</span>
              {p.error ? (
                <>
                  <span className="pc-num">?</span>
                  <span className="pc-sub" title={p.error}>Chưa đọc được bài của page này</span>
                </>
              ) : (
                <>
                  <span className="pc-num">{c.total}</span>
                  <span className="pc-sub">
                    {c.video} video · {c.photo} ảnh · {c.noCode} chưa gắn mã · mới nhất {fmtDay(c.lastDay)}
                    {p.source === "pancake" ? " · lấy qua Pancake" : p.source === "composio" ? " · lấy qua Composio" : ""}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>

      <div className="card">
        <div className="filters">
          <input
            value={code}
            onChange={(e) => { setCode(normCode(e.target.value)); setNoCode(false); reset(); }}
            placeholder="Lọc mã, vd ADT26001"
            size={20}
            aria-label="Lọc theo mã sản phẩm"
          />
          {KINDS.map(([k, label]) => (
            <a key={k} href="#" className={kind === k ? "on" : ""} onClick={(e) => { e.preventDefault(); setKind(k); reset(); }}>
              {label}
            </a>
          ))}
          {offCount || scope === "off" ? (
            <a
              href="#"
              className={scope === "off" ? "on" : ""}
              title="Video Pancake giữ nhưng không nằm trên tường page, thường là video tạo riêng cho quảng cáo. Không tính vào số bài đã đăng."
              onClick={(e) => { e.preventDefault(); setScope(scope === "off" ? "wall" : "off"); reset(); }}
            >
              Ngoài tường ({offCount})
            </a>
          ) : null}
          <label className="chk">
            <input type="checkbox" checked={noCode} onChange={(e) => { setNoCode(e.target.checked); if (e.target.checked) setCode(""); reset(); }} /> Chỉ bài chưa gắn mã
          </label>
          {code || kind || noCode || page || scope === "off" ? (
            <button type="button" className="secondary" onClick={() => { setCode(""); setKind(""); setNoCode(false); setPage(""); setScope("wall"); reset(); }}>
              Bỏ lọc
            </button>
          ) : null}
          <span className="spacer" />
          <b>{list.length} {scope === "off" ? "video ngoài tường" : "bài"}</b>
        </div>
        {codes.length ? (
          <div className="codechips">
            {codes.slice(0, 40).map((c) => (
              <button type="button" key={c.code} className={`chip${code === c.code ? " on" : ""}`} onClick={() => { setCode(code === c.code ? "" : c.code); setNoCode(false); reset(); }}>
                {c.code} <b>{c.posts}</b>
              </button>
            ))}
            {codes.length > 40 ? <span className="sub">và {codes.length - 40} mã khác (gõ mã vào ô lọc)</span> : null}
          </div>
        ) : null}
      </div>

      {list.length === 0 ? (
        <div className="card">
          <p className="sub">Không có bài nào khớp bộ lọc trong khoảng ngày này.</p>
        </div>
      ) : (
        <div className="postgrid">
          {list.slice(0, shown).map((p) => (
            <article key={p.id} className="post">
              <a className="thumb" href={p.permalink ?? "#"} target="_blank" rel="noreferrer" title="Mở bài trên Facebook">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.picture ? <img src={p.picture} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="noimg">Không có ảnh</span>}
                <span className={`kind k-${p.kind}`}>{p.offWall ? "Ngoài tường" : KIND_LABEL[p.kind]}</span>
                <span className="day">{fmtDay(p.day)}</span>
              </a>
              <div className="body">
                <div className="codes">
                  {p.codes.length ? (
                    p.codes.map((c) => (
                      <button type="button" key={c} className="chip" onClick={() => { setCode(c); setNoCode(false); reset(); }}>
                        {c}
                      </button>
                    ))
                  ) : (
                    <span className="chip none">Chưa gắn mã</span>
                  )}
                </div>
                <p className="msg" title={p.message}>{p.message || "(bài không có chữ)"}</p>
                <div className="foot">
                  <span className="sub">{names.get(p.page_id)}</span>
                  <span className="spacer" />
                  <button type="button" className="secondary" onClick={() => copy(p.id)}>{copied === p.id ? "Đã chép" : "Chép ID"}</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {list.length > shown ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="secondary" onClick={() => setShown((n) => n + PER_PAGE)}>
            Xem thêm ({list.length - shown} bài)
          </button>
        </p>
      ) : null}
    </>
  );
}
