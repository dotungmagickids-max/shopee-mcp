"use server";

import { cookies } from "next/headers";
import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, isValidSession } from "@/lib/autopilot/admin-auth";
import { FB_CACHE_TAG } from "@/lib/facebook/magic-data";

/** Nút "Làm mới" ở /fb: xóa bản lưu tạm để lần mở sau đọc lại Meta + Pancake. */
export async function lamMoiFb(form: FormData) {
  const jar = await cookies();
  if (!isValidSession(jar.get(ADMIN_COOKIE)?.value)) redirect("/admin/login?next=/fb");
  updateTag(FB_CACHE_TAG);
  const back = String(form.get("back") ?? "/fb");
  redirect(back.startsWith("/fb") ? back : "/fb");
}
