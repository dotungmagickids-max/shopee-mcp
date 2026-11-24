import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ADMIN_COOKIE, isValidSession } from "@/lib/autopilot/admin-auth";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "FB Magic Tool", robots: { index: false, follow: false } };

/** Chỉ anh Tùng: dùng chung phiên đăng nhập /admin (ADMIN_PASSWORD). */
export default async function FbLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!isValidSession(jar.get(ADMIN_COOKIE)?.value)) redirect("/admin/login?next=/fb");
  return (
    <div className="admin fb">
      <link rel="stylesheet" href="/admin.css" precedence="default" />
      <link rel="stylesheet" href="/fb.css" precedence="default" />
      <nav className="nav">
        <b>FB Magic Tool</b>
        <a href="/fb/muc-tieu">Mục tiêu</a>
        <a href="/fb">Đánh giá</a>
        <a href="/fb/de-xuat">Đề xuất chạy</a>
        <a href="/fb/noi-dung">Bài đã đăng</a>
        <a href="/fb/len-camp">Lên camp</a>
        <a href="/fb/tran">Bảng trần</a>
        <span className="spacer" />
        <span className="tag" title="Lên camp luôn tạo ở trạng thái tạm dừng. Nút ở màn Đánh giá chưa gọi lệnh ghi.">TẠO = TẠM DỪNG</span>
        <a href="/admin">Web quản trị</a>
      </nav>
      {children}
    </div>
  );
}
