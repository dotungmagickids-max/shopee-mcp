import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/autopilot/admin-auth";
import { adminLinks } from "@/lib/env";

export const dynamic = "force-dynamic";

interface Muc {
  ten: string;
  href?: string | null;
  /** Ghi chú nhỏ cạnh tên: "đang làm", "chưa có", "chưa gắn link". */
  ghiChu?: string;
  ngoai?: boolean;
}

/** Menu chung của Web quản trị: trang "Hôm nay" và đường dẫn tới các phần mềm con đang chạy. */
function menu(): Muc[] {
  const l = adminLinks();
  const ngoai = (ten: string, href: string | null): Muc => ({ ten, href, ngoai: true, ghiChu: href ? undefined : "chưa gắn link" });
  return [
    { ten: "Hôm nay", href: "/admin/hom-nay" },
    { ten: "QC Shopee", href: "/admin/shopee" },
    { ten: "QC Facebook", href: "/fb", ghiChu: "đang làm" },
    { ten: "QC TikTok", ghiChu: "chưa có" },
    { ten: "Sản xuất", href: "/san-xuat", ghiChu: "đang làm" },
    ngoai("Nội dung: lịch bài", l.noiDung),
    { ten: "Shopee Video", href: "/video" },
    ngoai("Kho", l.kho),
    { ten: "Đóng hàng", href: "/kho" },
    { ten: "Việc", href: "/admin/hom-nay#viec" },
    ngoai("Mã hàng", l.maHang),
  ];
}

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <nav className="menu" aria-label="Web quản trị Magickids">
        {menu().map((m) =>
          m.href ? (
            <a key={m.ten} href={m.href} {...(m.ngoai ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {m.ten}
              {m.ghiChu ? <small>{m.ghiChu}</small> : null}
            </a>
          ) : (
            <span key={m.ten} className="off" aria-disabled="true">
              {m.ten}
              {m.ghiChu ? <small>{m.ghiChu}</small> : null}
            </span>
          )
        )}
        <form method="post" action="/api/admin/logout">
          <button type="submit" className="secondary">Đăng xuất</button>
        </form>
      </nav>
      {children}
    </>
  );
}
