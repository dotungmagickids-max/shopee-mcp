import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Trang gốc sau đăng nhập: vào thẳng "Hôm nay". Giữ ?msg= của các nút duyệt cũ bằng cách chuyển về trang Shopee. */
export default async function AdminRoot({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const { msg } = await searchParams;
  redirect(msg ? `/admin/shopee?msg=${encodeURIComponent(msg)}` : "/admin/hom-nay");
}
