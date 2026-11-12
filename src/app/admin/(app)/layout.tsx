import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/autopilot/admin-auth";
import { isDryRun, liveActions } from "@/lib/autopilot/config";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <nav className="nav">
        <a href="/admin">Tổng quan</a>
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
        <form method="post" action="/api/admin/logout">
          <button type="submit" className="secondary">Đăng xuất</button>
        </form>
      </nav>
      {children}
    </>
  );
}
