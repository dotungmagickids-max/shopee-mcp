import { adminChange, decide, type ActionKind } from "@/lib/autopilot/actions";
import { adminFromRequest } from "@/lib/autopilot/admin-auth";
import { shops } from "@/lib/autopilot/config";
import { proposeCapsForUnlimited } from "@/lib/autopilot/rules";
import { proposeRefresh } from "@/lib/autopilot/refresh";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Form POST từ dashboard:
 *   op=decide  id, approve=1|0                 duyệt / bỏ qua đề xuất
 *   op=edit    shop_id, campaign_id, kind, value   sửa chiến dịch (change_budget | change_roas_target | pause | resume)
 *   op=exclude shop_id, campaign_id, excluded=1|0  loại / đưa lại chiến dịch vào tự động
 */
export async function POST(request: Request) {
  if (!adminFromRequest(request)) return new Response("unauthorized", { status: 401 });
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return new Response("bad origin", { status: 403 });
  const form = await request.formData();
  const op = String(form.get("op") ?? "");
  const back = String(form.get("back") ?? "/admin");
  const safeBack = back.startsWith("/admin") ? back : "/admin";
  let msg = "";

  if (op === "decide") {
    const res = await decide(Number(form.get("id")), form.get("approve") === "1", "admin");
    msg = res.message;
  } else if (op === "refresh") {
    const shopId = Number(form.get("shop_id"));
    if (!shops().some((s) => s.shopId === shopId)) return new Response("bad shop", { status: 400 });
    const res = await proposeRefresh(shopId, "admin");
    msg = "items" in res
      ? `Rà xong: ${res.candidates} chiến dịch nên làm mới, đề xuất ${res.items}; ${res.productIssues} sản phẩm cần xem (Telegram)`
      : String(res.skipped);
  } else if (op === "caps") {
    const shopId = Number(form.get("shop_id"));
    if (!shops().some((s) => s.shopId === shopId)) return new Response("bad shop", { status: 400 });
    const res = await proposeCapsForUnlimited(shopId, "admin");
    msg = "items" in res ? `Đã tạo đề xuất hạn mức cho ${res.items} chiến dịch (xem bên dưới / Telegram)` : String(res.skipped);
  } else {
    const shopId = Number(form.get("shop_id"));
    const campaignId = Number(form.get("campaign_id"));
    if (!shops().some((s) => s.shopId === shopId) || !campaignId) return new Response("bad input", { status: 400 });
    const { data: camp } = await db()
      .from("ads_campaigns")
      .select("campaign_status, campaign_budget, roas_target")
      .eq("shop_id", shopId)
      .eq("campaign_id", campaignId)
      .maybeSingle();
    if (!camp) return new Response("unknown campaign", { status: 404 });

    if (op === "exclude") {
      const excluded = form.get("excluded") === "1";
      await db().from("ads_campaigns").update({ autopilot_excluded: excluded }).eq("shop_id", shopId).eq("campaign_id", campaignId);
      msg = excluded ? `Đã loại #${campaignId} khỏi tự động` : `Đã đưa #${campaignId} lại vào tự động`;
    } else if (op === "edit") {
      const kind = String(form.get("kind")) as ActionKind;
      const raw = String(form.get("value") ?? "").trim();
      // Ngân sách: bỏ dấu phân cách nghìn ("1.000.000"); ROAS: cho phép "10,5" hoặc "10.5".
      const value = kind === "change_budget" ? Number(raw.replace(/[^\d]/g, "")) : Number(raw.replace(",", "."));
      let before: Record<string, unknown>;
      let after: Record<string, unknown>;
      if (kind === "change_budget") {
        if (!Number.isFinite(value) || value <= 0) return new Response("Ngân sách phải > 0", { status: 400 });
        before = { budget: Number(camp.campaign_budget) };
        after = { budget: value };
      } else if (kind === "change_roas_target") {
        if (!Number.isFinite(value) || value <= 0) return new Response("ROAS phải > 0", { status: 400 });
        before = { roas_target: camp.roas_target };
        after = { roas_target: value };
      } else if (kind === "pause" || kind === "resume") {
        before = { status: camp.campaign_status };
        after = { status: kind === "pause" ? "paused" : "ongoing" };
      } else {
        return new Response("bad kind", { status: 400 });
      }
      const res = await adminChange({ shop_id: shopId, campaign_id: campaignId, action: kind, before, after, reason: "Sửa trên dashboard", source: "admin" });
      msg = `#${campaignId}: ${res.status}${res.error ? ` — ${res.error}` : ""}`;
    } else {
      return new Response("bad op", { status: 400 });
    }
  }
  return Response.redirect(`${url.origin}${safeBack}${safeBack.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`, 303);
}
