import type { Metadata } from "next";
import type { ReactNode } from "react";
import { taiHomNay, type CotBan, type HomNay } from "@/lib/quan-tri/hom-nay";
import { HE_SO_QC, TEN_NEN_TANG, ngayNgan, phanTram, tien, type OBan } from "@/lib/quan-tri/tinh";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Hôm nay · Magickids" };

const so = (v: number | null | undefined) => (v == null ? "chưa có" : new Intl.NumberFormat("vi-VN").format(Math.round(v)));

function Khoi({ id, ten, luc, children }: { id: string; ten: string; luc?: string | null; children: ReactNode }) {
  return (
    <section className="card hn-khoi" id={id}>
      <header>
        <h2>{ten}</h2>
        <span className="muted">{luc ? `số lúc ${luc}` : "chưa có giờ cập nhật"}</span>
      </header>
      {children}
    </section>
  );
}

/** Ô số: thiếu thì ghi "chưa có" (kèm lý do khi rê chuột), không ghi 0. */
function O({ v, vi }: { v: string; vi?: string | null }) {
  return v === "chưa có" ? <td className="thieu" title={vi ?? undefined}>chưa có</td> : <td>{v}</td>;
}

function So({ nhan, gia, phu, xau }: { nhan: string; gia: string; phu?: ReactNode; xau?: boolean }) {
  return (
    <div className={`kpi${xau ? " bad" : ""}${gia === "chưa có" ? " thieu" : ""}`}>
      <div className="label">{nhan}</div>
      <div className="value">{gia}</div>
      {phu ? <div className="label">{phu}</div> : null}
    </div>
  );
}

function BangBan({ c, homNay }: { c: CotBan; homNay: boolean }) {
  const ghiChu = new Set<string>();
  const note = (ten: string, o: OBan) => {
    if (o.thieu) ghiChu.add(`${ten}: ${o.thieu}`);
    else if (o.laiGhiChu) ghiChu.add(`${ten}: lãi ${o.lai == null ? "chưa có, " : ""}${o.laiGhiChu}`);
  };
  c.dong.forEach((d) => note(d.kenh.ten, d.o));
  const t = c.tong;
  return (
    <div className="hn-ngay">
      <h3>
        {c.nhan} <span className="muted">({ngayNgan(c.ngay)})</span>
      </h3>
      <div className="kpis">
        <So nhan={`Doanh số${t.thieuKenh.length ? " (chưa đủ kênh)" : ""}`} gia={tien(t.doanhSo)} phu={t.don == null ? null : `${so(t.don)} đơn chốt`} />
        <So nhan={`Lãi sau quảng cáo${t.lai != null && t.thieuLai.length ? " (chưa đủ kênh)" : ""}`} gia={tien(t.lai)} xau={t.lai != null && t.lai < 0}
          phu={t.thieuLai.length ? `chưa gồm ${t.thieuLai.join(", ")}` : null} />
        <So nhan={`Cùng thứ tuần trước (${ngayNgan(c.ngaySo)}${homNay ? ", cả ngày" : ""})`} gia={tien(c.tongTruoc.doanhSo)}
          phu={homNay ? "hôm nay chưa hết ngày, không so %" : c.thayDoi == null ? null : `${phanTram(c.thayDoi, true)} so với tuần trước`} />
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th className="l">Kênh</th><th>Đơn</th><th>Doanh số</th><th>Tuần trước</th><th>Lãi sau QC</th></tr>
          </thead>
          <tbody>
            {c.dong.map(({ kenh, o, truoc, thayDoi }) => (
              <tr key={kenh.code}>
                <td className="l">{kenh.ten}</td>
                <O v={so(o.don)} vi={o.thieu} />
                <O v={tien(o.doanhSo)} vi={o.thieu} />
                <O v={truoc.doanhSo == null ? "chưa có" : `${tien(truoc.doanhSo)}${!homNay && thayDoi != null ? ` (${phanTram(thayDoi, true)})` : ""}`} vi={truoc.thieu} />
                {o.lai == null ? <td className="thieu" title={o.laiGhiChu ?? undefined}>chưa có</td> : <td className={o.lai < 0 ? "neg" : ""}>{tien(o.lai)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ghiChu.size ? <ul className="hn-ghichu">{[...ghiChu].map((g) => <li key={g}>{g}</li>)}</ul> : null}
    </div>
  );
}

function Ban({ d }: { d: HomNay }) {
  const b = d.ban;
  return (
    <Khoi id="doanh-so" ten="Doanh số và lãi" luc={b.soLucShopee}>
      {b.loi ? <p className="warning">Chưa đọc được doanh số: <code>{b.loi}</code></p> : null}
      {b.cot.map((c, i) => <BangBan key={c.ngay} c={c} homNay={i === 1} />)}
      <p className="muted">
        Doanh số = giá bán hàng giữ lại (đã bỏ đơn hủy, hoàn). Shopee: đơn lấy từ Shopee 15 phút một lần{b.soLucShopee ? ` (lúc ${b.soLucShopee})` : ""}; tiền về
        của đơn chưa quyết toán là ước tính nên lãi còn đổi. Facebook, TikTok: đơn Pancake đẩy lên mỗi sáng khoảng 07:00,{" "}
        {b.soLucPancake ? <>đơn mới nhất tạo lúc <b>{b.soLucPancake}</b></> : "chưa biết đơn mới nhất đến lúc nào"}
        {b.pancakeLoi ? <span className="error"> (lần đồng bộ gần nhất bị lỗi)</span> : null}.
      </p>
    </Khoi>
  );
}

function QuangCao({ d }: { d: HomNay }) {
  const q = d.qc;
  const t = q.thang;
  return (
    <Khoi id="quang-cao" ten="Quảng cáo" luc={q.soLuc}>
      {q.loi ? <p className="warning">Chưa đọc được số quảng cáo: <code>{q.loi}</code></p> : null}
      <h3>Chi thật tháng {Number(d.homNay.slice(5, 7))} so với trần</h3>
      <div className="hn-tran">
        <b className={t.vuot ? "error" : ""}>{tien(t.tong)}</b> / {tien(t.tran)}
        {t.pct != null ? <span className="muted"> ({phanTram(t.pct)}{t.thieu.length ? ", chưa đủ kênh" : ""})</span> : null}
      </div>
      <div className={`hn-bar${t.vuot ? " vuot" : t.pct != null && t.pct >= 0.9 ? " gan" : ""}`}><i style={{ width: `${Math.min(100, Math.round((t.pct ?? 0) * 100))}%` }} /></div>
      <p className="muted">
        {t.conLai == null ? "Chưa có số nào để so trần." : t.vuot ? `Đã vượt trần ${tien(-t.conLai)}.` : `Còn ${tien(t.conLai)} tới trần.`}{" "}
        {q.thangPhan.filter((p) => p.chi != null).map((p) => `${TEN_NEN_TANG[p.nenTang]} ${tien(p.chi)}`).join(" · ")}
      </p>
      {t.thieu.length ? (
        <ul className="hn-ghichu canh-bao">{t.thieu.map((x) => <li key={x}>{x} (tổng thật có thể cao hơn)</li>)}</ul>
      ) : null}
      {q.ngay.map((n) => (
        <div className="hn-ngay" key={n.ngay}>
          <h3>{n.nhan} <span className="muted">({ngayNgan(n.ngay)})</span></h3>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th className="l">Kênh</th><th>Chi thật</th><th>Doanh số</th><th>Chi / doanh số</th></tr></thead>
              <tbody>
                {n.dong.map((r) => (
                  <tr key={r.nenTang}>
                    <td className="l">{TEN_NEN_TANG[r.nenTang]}</td>
                    <O v={tien(r.chi)} vi={r.thieu} />
                    <O v={tien(r.doanhSo)} />
                    <O v={phanTram(r.tyLe)} vi={r.thieu} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <p className="muted">
        Chi thật = số nền tảng báo × hệ số: Shopee × {String(HE_SO_QC.shopee).replace(".", ",")}; Facebook × {String(HE_SO_QC.facebook).replace(".", ",")}; TikTok × {String(HE_SO_QC.tiktok).replace(".", ",")}.
        Doanh số là doanh số cả kênh (không riêng đơn từ quảng cáo). TikTok chưa có nguồn chi quảng cáo.
      </p>
    </Khoi>
  );
}

function Ton({ d }: { d: HomNay }) {
  const t = d.ton;
  const sapHet = t.sapHet?.slice(0, 15) ?? [];
  const am = t.am?.slice(0, 15) ?? [];
  return (
    <Khoi id="ton" ten="Tồn sắp hết" luc={t.soLuc}>
      {t.loi ? <p className="warning">Chưa đọc được tồn kho: <code>{t.loi}</code></p> : null}
      <h3>Còn dưới 7 ngày bán {t.sapHet ? <span className="muted">({t.sapHet.length} mã)</span> : null}</h3>
      {t.sapHet == null ? <p className="thieu">chưa có dữ liệu</p> : !sapHet.length ? <p className="muted">Không có mã nào.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th className="l">Mã</th><th>Tồn</th><th>Bán / ngày</th><th>Còn (ngày)</th></tr></thead>
            <tbody>
              {sapHet.map((m) => (
                <tr key={m.code}><td className="l">{m.code}</td><td>{so(m.ton)}</td><td>{m.banNgay.toFixed(1).replace(".", ",")}</td><td className={m.conNgay < 3 ? "neg" : ""}>{m.conNgay.toFixed(1).replace(".", ",")}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {t.sapHet && t.sapHet.length > sapHet.length ? <p className="muted">và {t.sapHet.length - sapHet.length} mã nữa.</p> : null}
      <h3>Đang âm tồn (bán vượt số trong kho) {t.am ? <span className="muted">({t.am.length} mã)</span> : null}</h3>
      {t.am == null ? <p className="thieu">chưa có dữ liệu</p> : !am.length ? <p className="muted">Không có mã nào.</p> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th className="l">Mã</th><th>Số màu-size âm</th><th>Tổng âm</th></tr></thead>
            <tbody>{am.map((m) => <tr key={m.code}><td className="l">{m.code}</td><td>{m.bienThe}</td><td className="neg">{so(m.tongAm)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {t.am && t.am.length > am.length ? <p className="muted">và {t.am.length - am.length} mã nữa.</p> : null}
      <p className="muted">Tồn và tốc độ bán lấy từ Pancake mỗi đêm 01:15 (cộng mọi kênh). Chưa lọc riêng mã chủ lực vì danh mục chưa gắn nhóm cho mã: đang hiện mọi mã còn hàng.</p>
    </Khoi>
  );
}

function Don({ d }: { d: HomNay }) {
  const o = d.don;
  const dh = o.dongHang;
  const coDs = dh != null && dh.tong > 0;
  return (
    <Khoi id="don" ten="Đơn" luc={o.dongHangLuc ?? o.soLucShopee}>
      <div className="kpis">
        <So nhan={`Đóng hàng hôm nay${o.dongHangLuc ? ` (lúc ${o.dongHangLuc})` : ""}`}
          gia={dh == null ? "chưa có" : coDs ? `${dh.daDong} / ${dh.tong}` : `${dh.ngoaiDanhSach} đơn`}
          xau={coDs && dh.daDong < dh.tong}
          phu={dh == null ? o.dongHangLoi : coDs ? (dh.tong - dh.daDong ? `còn ${dh.tong - dh.daDong} đơn chưa đóng` : "đã đóng hết") : "chưa có danh sách đơn cần đóng hôm nay"} />
        <So nhan="Shopee chờ gửi (30 ngày)" gia={so(o.shopeeChoGui)} phu={o.shopeeChoGui == null ? o.shopeeLoi : o.soLucShopee ? `lúc ${o.soLucShopee}` : null} />
        {(o.pancakeMo ?? []).map((p) => (
          <So key={p.nhan} nhan={`Pancake: ${p.nhan}`} gia={so(p.so)} phu={p.cuNhat ? `cũ nhất ${ngayNgan(p.cuNhat)}` : null} />
        ))}
        {o.pancakeMo == null ? <So nhan="Pancake: đơn chưa đóng, chờ hàng" gia="chưa có" phu={d.thieuHam ? "cần chạy migration 0024" : "chưa đọc được"} /> : null}
        <So nhan="Viettel Post lỗi, hoàn" gia="chưa có" phu="chưa có bảng dữ liệu" />
      </div>
      <p className="muted">
        Đóng hàng đếm theo video quầy đóng hàng; chi tiết từng đơn xem <a href="/kho">màn Tiến độ đóng hàng</a>.
        {o.pancakeMo ? ` Đơn Pancake tính 60 ngày gần đây, theo lần đồng bộ sáng (đơn mới nhất tạo lúc ${o.pancakeLuc ?? "?"}); "Chờ hàng" là đơn thiếu hàng.` : ""}
      </p>
    </Khoi>
  );
}

function Viec({ d }: { d: HomNay }) {
  const v = d.viec;
  const nguoi = v.nguoi ?? [];
  const tong = (k: "mo" | "tre" | "gap") => (v.nguoi ? nguoi.reduce((s, x) => s + x[k], 0) : null);
  const anh = v.nguoi ? nguoi.filter((x) => /anh\s*tùng/i.test(x.nguoi)).reduce((s, x) => s + x.mo, 0) : null;
  const hon = v.itNhat ? "≥ " : "";
  return (
    <Khoi id="viec" ten="Việc" luc={v.soLuc}>
      {v.loi ? <p className="warning">Chưa đọc được bảng việc: <code>{v.loi}</code></p> : null}
      <div className="kpis">
        <So nhan="Việc đang mở" gia={tong("mo") == null ? "chưa có" : `${hon}${so(tong("mo"))}`} />
        <So nhan="Trễ hạn" gia={tong("tre") == null ? "chưa có" : `${hon}${so(tong("tre"))}`} xau={(tong("tre") ?? 0) > 0} />
        <So nhan="Việc giao cho anh" gia={so(anh)} xau={(anh ?? 0) > 3} phu="luật: tối đa 3 việc mỗi ngày" />
        <So nhan="Đề xuất chờ anh duyệt" gia={so(v.deXuatSo)} xau={(v.deXuatSo ?? 0) > 0} />
      </div>
      {v.itNhat ? <p className="warning">Mới đếm được 200 việc đầu (cần chạy migration 0024 để đếm đủ).</p> : null}
      {nguoi.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th className="l">Người làm</th><th>Mở</th><th>Trễ hạn</th><th>Gấp</th></tr></thead>
            <tbody>
              {nguoi.map((x) => (
                <tr key={x.nguoi}><td className="l">{x.nguoi}</td><td>{x.mo}</td><td className={x.tre ? "neg" : ""}>{x.tre}</td><td>{x.gap}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {v.deXuat?.length ? (
        <ul className="hn-ghichu">{v.deXuat.map((x) => <li key={`${x.phong}|${x.viec}`}>{x.phong}: {x.so} đề xuất “{x.viec}”</li>)}</ul>
      ) : null}
      <p className="muted">Chỉ hiện số đếm. Nội dung việc xem trong Telegram hoặc hỏi phòng phụ trách.</p>
    </Khoi>
  );
}

const TINH_TRANG = { tot: ["tốt", "ok"], tre: ["trễ", "error"], loi: ["lỗi", "error"], chua_co: ["chưa có", "thieu"] } as const;

function HeThong({ d }: { d: HomNay }) {
  const h = d.heThong;
  return (
    <Khoi id="he-thong" ten="Hệ thống" luc={d.luc}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th className="l">Nguồn</th><th>Lần cuối</th><th>Tình trạng</th></tr></thead>
          <tbody>
            {h.nguon.map((n) => (
              <tr key={n.ten}>
                <td className="l">{n.ten}<div className="muted">{n.chuKy}{n.ghiChu ? ` · ${n.ghiChu}` : ""}</div></td>
                <td>{n.lanCuoi ?? "—"}</td>
                <td className={TINH_TRANG[n.tinhTrang][1]}>{TINH_TRANG[n.tinhTrang][0]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {h.loi24h == null ? <p className="thieu">Chưa đọc được nhật ký lịch chạy.</p> : h.loi24h.length ? (
        <p className="warning">Lịch Shopee lỗi trong 24 giờ qua: {h.loi24h.map((x) => `${x.job} (${x.luc ?? "?"})`).join(", ")}. Chi tiết ở <a href="/admin/log">Nhật ký</a>.</p>
      ) : <p className="muted">Lịch Shopee 24 giờ qua không lỗi.</p>}
    </Khoi>
  );
}

export default async function HomNayPage() {
  const d = await taiHomNay();
  return (
    <>
      <h1>Hôm nay <span className="muted">{ngayNgan(d.homNay)} · mở lúc {d.luc}</span></h1>
      {d.thieuHam ? (
        <p className="warning">
          Một số khối (việc đếm đủ, đề xuất, đơn Pancake, đồng bộ Pancake) chưa có số vì database chưa có hàm <code>mk_web_hom_nay</code>: cần anh duyệt chạy migration 0024.
        </p>
      ) : null}
      <div className="hn-luoi">
        <Ban d={d} />
        <QuangCao d={d} />
        <Ton d={d} />
        <Don d={d} />
        <Viec d={d} />
        <HeThong d={d} />
      </div>
    </>
  );
}
