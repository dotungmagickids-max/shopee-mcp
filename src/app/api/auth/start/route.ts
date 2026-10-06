import { appUrl, partnerCredentials } from "@/lib/env";
import { parseAccess, parseRegion } from "@/lib/regions";
import { partnerSdk } from "@/lib/shopee";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";

/** Form POST from the home page: remember the choice, then send the seller to Shopee. */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const region = parseRegion(form.get("region"));
  const access = parseAccess(form.get("access"));
  const label = String(form.get("label") ?? "").trim().slice(0, 100) || null;
  if (!region || !access) {
    return new Response("Invalid region or access level", { status: 400 });
  }
  if (!partnerCredentials(region)) {
    return new Response(`Region ${region} is not configured on this server`, { status: 400 });
  }

  const { data, error } = await db()
    .from("auth_requests")
    .insert({ region, access, label })
    .select("id")
    .single();
  if (error) {
    return new Response(`Could not start authorization: ${error.message}`, { status: 500 });
  }

  // Shopee appends ?code=…&shop_id=… (or main_account_id) to this URL.
  const redirectUri = `${appUrl(request)}/api/auth/callback?request_id=${data.id}`;
  return Response.redirect(partnerSdk(region).getAuthorizationUrl(redirectUri), 303);
}
