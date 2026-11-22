import type { ReactNode } from "react";
import { isDryRun, liveActions } from "@/lib/autopilot/config";

/** Menu con của Quảng cáo › Shopee (Ads Autopilot). Đăng nhập đã kiểm ở layout cha. */
export default function ShopeeLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="nav">
        <a href="/admin/shopee">Tổng quan</a>
        <a href="/admin/campaigns">Chiến dịch</a>
        <a href="/admin/lifecycle">Vòng đời sản phẩm</a>
        <a href="/admin/heatmap">Bản đồ nhiệt</a>
        <a href="/admin/log">Nhật ký</a>
        <a href="/admin/settings">Cài đặt</a>
        <span className="spacer" />
        {isDryRun() ? (
          <span className="tag" title="Hành động chạy thật dù đang dry-run">
            DRY-RUN{liveActions().length ? ` (chạy thật: ${liveActions().join(", ")})` : ""}
          </span>
        ) : null}
      </nav>
      {children}
    </>
  );
}
