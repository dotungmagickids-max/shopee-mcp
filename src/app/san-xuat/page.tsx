import {
  conChoVe,
  conNoTheoMau,
  fmt,
  homNayVN,
  maTran,
  mauCat,
  moTaLanVe,
  ngayVN,
  nhanLo,
  nhanPancake,
  nhatKy,
  phieuChoCat,
  tinhLo,
  tomTat,
  tongLanVe,
  xepLo,
  type TienDoLo,
} from "@/lib/san-xuat";
import { docSoSanXuat, type SoSanXuat } from "@/lib/san-xuat-data";

export const dynamic = "force-dynamic";

type Tab = "lo" | "ve" | "dat";
type Loc = "cho" | "tre" | "tat";
const TABS: [Tab, string][] = [
  ["lo", "Tiến độ theo lô"],
  ["ve", "Hàng về"],
  ["dat", "Phiếu đặt chờ cắt"],
];
const LOCS: [Loc, string][] = [
  ["cho", "Đang chờ về"],
  ["tre", "Trễ hẹn"],
  ["tat", "Tất cả"],
];

const href = (tab: Tab, loc: Loc) => {
  const q = new URLSearchParams();
  if (tab !== "lo") q.set("tab", tab);
  if (loc !== "cho") q.set("loc", loc);
  const s = q.toString();
  return s ? `/san-xuat?${s}` : "/san-xuat";
};

function MaTranConNo({ t }: { t: TienDoLo }) {
  const m = maTran(t);
  if (!m) {
    const theoMau = conNoTheoMau(t);
    if (!theoMau.length) return null;
    return (
      <div className="note">
        <b>Còn {theoMau.map((x) => `${x.mau} ${fmt(Math.max(0, x.conNo))}`).join(" · ")}</b> (chưa chia được theo size)
      </div>
    );
  }
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Còn nợ</th>
            {m.sizes.map((s) => (
              <th key={s}>{s}</th>
            ))}
            <th>Tổng</th>
          </tr>
        </thead>
        <tbody>
          {m.hang.map((h) => (
            <tr key={h.mau}>
              <td>{h.mau || "Chưa rõ màu"}</td>
              {h.o.map((x, i) =>
                x == null ? (
                  <td key={i} className="zero">·</td>
                ) : (
                  <td key={i} className={`num ${x === 0 ? "zero" : x >= 20 ? "hot" : ""}`}>{fmt(x)}</td>
                )
              )}
              <td className="num"><b>{fmt(h.tong)}</b></td>
            </tr>
          ))}
          <tr>
            <td><b>Tổng</b></td>
            {m.tong.map((x, i) => (
              <td key={i} className="num"><b>{fmt(x)}</b></td>
            ))}
            <td className="num"><b>{fmt(m.tongCong)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Lo({ t, homNay, mo }: { t: TienDoLo; homNay: string; mo: boolean }) {
  const s = nhanLo(t, homNay);
  const chuaDoiSoat = t.lo.trang_thai === "chua_doi_soat";
  const pct = t.soCat > 0 ? Math.min(100, (t.khoDem / t.soCat) * 100) : 0;
  const doiHen = t.lo.doi_hen ?? [];
  return (
    <details className={`lot ${s.k === "late" ? "is-late" : ""}`} open={mo}>
      <summary>
        <div className="code">
          {t.lo.ma_hang} <span>{t.lo.lo}</span>
          <small>{mauCat(t.lo)}</small>
        </div>
        <div className="mid">
          <div className="bar" role="img" aria-label={`Đã về ${fmt(t.khoDem)} trên ${fmt(t.soCat)}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="meta">
            <span>Cắt <b className="num">{fmt(t.soCat)}</b></span>
            <span>Đã về <b className="num">{chuaDoiSoat ? "—" : fmt(t.khoDem)}</b></span>
            <span>Còn nợ <b className="num">{chuaDoiSoat ? "?" : fmt(Math.max(0, t.conNo))}</b></span>
            {t.choKhoDem > 0 ? <span>Chờ kho đếm <b className="num">{fmt(t.choKhoDem)}</b></span> : null}
          </div>
        </div>
        <div className="right">
          <span className={`pill ${s.k}`}>{s.t}</span>
          <span className="due">{t.lo.hen_tra ? `Hẹn trả ${ngayVN(t.lo.hen_tra)}` : "Chưa có ngày hẹn"}</span>
        </div>
      </summary>
      <div className="detail">
        {chuaDoiSoat ? null : <MaTranConNo t={t} />}
        {t.conNo < 0 ? <div className="note"><b>Về thừa {fmt(-t.conNo)} cái so với số cắt.</b></div> : null}
        {t.lo.ghi_chu ? <div className="note">{t.lo.ghi_chu}</div> : null}
        <div className="note">
          {t.lanVe.length
            ? `Về ${t.lanVe
                .map((h) => {
                  const v = tongLanVe(h);
                  const so = v.choKhoDem > 0 && v.khoDem === 0 ? `${fmt(v.xuongGiao)} xưởng giao, chờ kho đếm` : fmt(v.khoDem);
                  return `${ngayVN(h.ngay)}: ${so}${h.so_phieu_pancake ? ` (#${h.so_phieu_pancake})` : ""}`;
                })
                .join(" · ")}`
            : "Chưa về lần nào"}
          {t.lo.ngay_cat ? ` · Cắt ${ngayVN(t.lo.ngay_cat)}` : ""}
          {t.lo.gia != null ? ` · Giá ${fmt(t.lo.gia)} đ/cái` : ""}
        </div>
        {doiHen.length ? (
          <div className="note">
            Dời hẹn {doiHen.length} lần:{" "}
            {doiHen.map((d) => `${d.hen_cu ? ngayVN(d.hen_cu) : "chưa hẹn"} → ${ngayVN(d.hen_moi)} (${d.ly_do})`).join(" · ")}
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default async function SanXuatPage({ searchParams }: { searchParams: Promise<{ tab?: string; loc?: string }> }) {
  const sp = await searchParams;
  const tab: Tab = sp.tab === "ve" || sp.tab === "dat" ? sp.tab : "lo";
  const loc: Loc = sp.loc === "tre" || sp.loc === "tat" ? sp.loc : "cho";
  const homNay = homNayVN();

  let so: SoSanXuat;
  try {
    so = await docSoSanXuat();
  } catch (err) {
    return (
      <>
        <header>
          <div>
            <h1>Sổ hàng xưởng</h1>
            <div className="sub">Chưa đọc được dữ liệu</div>
          </div>
          <a className="badge" href="/admin">Quản trị</a>
        </header>
        <div className="empty">
          Chưa đọc được sổ. Thường là do migration <b>0024_san_xuat.sql</b> chưa được chạy trên Supabase.
          <br />
          Chi tiết: {err instanceof Error ? err.message : String(err)}
        </div>
      </>
    );
  }

  const tienDo = xepLo(so.los.map((l) => tinhLo(l, so.hangVe, homNay)));
  const cho = phieuChoCat(so.phieu, so.los);
  const tt = tomTat(tienDo, so.hangVe, cho, homNay);
  const ds = tienDo.filter((t) => (loc === "tre" ? conChoVe(t) && t.ngayTre > 0 : loc === "cho" ? conChoVe(t) : true));
  const ngay = nhatKy(so.hangVe, so.los).slice(0, 30);

  return (
    <>
      <header>
        <div>
          <h1>Sổ hàng xưởng</h1>
          <div className="sub">Đặt hàng, hàng về, tiến độ xưởng · hôm nay {ngayVN(homNay, true)} · chỉ xem</div>
        </div>
        <a className="badge" href="/admin">Quản trị</a>
      </header>

      <section className="kpis" aria-label="Tóm tắt">
        <div className="kpi late">
          <span className="v">{fmt(tt.loTre)}</span>
          <span className="l">lô trễ hẹn trả</span>
        </div>
        <div className="kpi">
          <span className="v">{fmt(tt.conNo)}</span>
          <span className="l">cái xưởng còn nợ (lô đã cắt)</span>
        </div>
        <div className="kpi">
          <span className="v">{fmt(tt.veHomNay)}</span>
          <span className="l">cái về kho hôm nay, {fmt(tt.phieuHomNay)} phiếu nhập</span>
        </div>
        <div className="kpi">
          <span className="v">{fmt(tt.choCat)}</span>
          <span className="l">cái đã đặt, xưởng chưa cắt</span>
        </div>
      </section>

      <div className="flow" aria-label="Các bước">
        <span className="st">Phiếu đặt</span>›<span className="st">Số cắt thật</span>›<span className="st">Xưởng giao</span>›
        <span className="st">Kho đếm, ký</span>›<span className="st">Nhập Pancake</span>›
        <span className="st next">Sổ tồn kho (nối sau)</span>
      </div>

      <nav className="tabs" aria-label="Mục">
        {TABS.map(([k, t]) => (
          <a key={k} href={href(k, "cho")} aria-current={k === tab ? "page" : undefined}>{t}</a>
        ))}
      </nav>

      {tab === "lo" ? (
        <section>
          <div className="filters">
            {LOCS.map(([k, t]) => (
              <a key={k} href={href("lo", k)} aria-current={k === loc ? "true" : undefined}>{t}</a>
            ))}
          </div>
          <div className="lots">
            {ds.length ? (
              ds.map((t, i) => <Lo key={t.lo.id} t={t} homNay={homNay} mo={i === 0} />)
            ) : (
              <div className="empty">{so.los.length ? "Không có lô nào ở nhóm này." : "Sổ chưa có lô cắt nào."}</div>
            )}
          </div>
        </section>
      ) : null}

      {tab === "ve" ? (
        <section className="log">
          {ngay.length ? (
            ngay.map((d) => (
              <div className="day" key={d.ngay}>
                <h3>
                  {ngayVN(d.ngay)}{" "}
                  <span>
                    · {fmt(d.khoDem)} cái kho đã đếm
                    {d.choKhoDem > 0 ? ` · ${fmt(d.choKhoDem)} cái xưởng giao chờ kho đếm` : ""}
                  </span>
                </h3>
                {d.lan.map((x) => (
                  <div className="row" key={x.h.id}>
                    <b>{x.lo ? `${x.lo.ma_hang} ${x.lo.lo}` : `Lô #${x.h.lo_id}`}</b>
                    <span className="what">
                      {moTaLanVe(x.h)}
                      <small>
                        {x.choKhoDem > 0 ? "Chờ kho đếm" : `Kho ký: ${x.h.nguoi_ky || "chưa ghi"}`}
                        {x.h.ghi_chu ? ` · ${x.h.ghi_chu}` : ""}
                      </small>
                    </span>
                    <span className="q num">{fmt(x.choKhoDem > 0 && x.khoDem === 0 ? x.xuongGiao : x.khoDem)}</span>
                    <span className="pk">{nhanPancake(x.h)}</span>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div className="empty">Chưa ghi lần hàng về nào.</div>
          )}
        </section>
      ) : null}

      {tab === "dat" ? (
        <section className="orders">
          {cho.length ? (
            cho.map(({ p, soDat, daCat, conCho }) => (
              <div className="po" key={p.id}>
                <div className="top">
                  <b>{p.ma_hang} {p.dot}</b>
                  <span className="pill warn">
                    {p.ngay_du_kien_cat ? `Dự kiến cắt ${ngayVN(p.ngay_du_kien_cat)}` : "Chưa có ngày cắt"}
                  </span>
                </div>
                <span className="big">{fmt(conCho)} <small>cái</small></span>
                <span className="note">
                  {daCat > 0 ? `Phiếu ${fmt(soDat)}, đã cắt ${fmt(daCat)}` : `Đặt ${fmt(soDat)}`}
                  {p.ngay_dat ? ` · đặt ${ngayVN(p.ngay_dat)}` : ""}
                  {p.gia != null ? ` · ${fmt(p.gia)} đ/cái` : ""}
                  {p.ghi_chu ? ` · ${p.ghi_chu}` : ""}
                </span>
              </div>
            ))
          ) : (
            <div className="empty">Không có phiếu đặt nào đang chờ cắt.</div>
          )}
        </section>
      ) : null}

      <footer>
        <span>Còn nợ = số cắt thật − số kho đếm. Hàng xưởng đã giao mà kho chưa đếm thì chưa tính là đã về.</span>
        <span>Số do Thu Hà ghi từ tin Zalo của xưởng, phiếu xưởng và chữ ký kho. Trang này chỉ xem, không ghi gì sang Pancake.</span>
      </footer>
    </>
  );
}
