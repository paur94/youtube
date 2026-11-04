import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

import { createTikTokOAuthClient, getTikTokConfig, getTikTokRedirectUri } from "@/server/providers/tiktok";
import { missingTikTokScopes, saveTikTokConnection } from "@/server/tiktok/connection";
import { TIKTOK_OAUTH_COOKIE, TIKTOK_OAUTH_COOKIE_PATH, verifyTikTokState } from "@/server/tiktok/oauth-cookie";

// TikTok redirects here after the authorization screen. Only a fixed outcome code is passed on to the
// Settings page, never text from the request, so nothing user-controlled is reflected.
function finish(request: NextRequest, outcome: string) {
  const response = NextResponse.redirect(new URL(`/settings?tiktok=${outcome}`, request.url));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(TIKTOK_OAUTH_COOKIE, "", { path: TIKTOK_OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (!verifyTikTokState(request.cookies.get(TIKTOK_OAUTH_COOKIE)?.value, params.get("state"))) return finish(request, "invalid_state");
  if (params.get("error")) return finish(request, params.get("error") === "access_denied" ? "denied" : "error");

  const code = params.get("code");
  const config = getTikTokConfig();
  if (!config.configured) return finish(request, "not_configured");
  if (!code) return finish(request, "error");

  const oauth = createTikTokOAuthClient(config);
  try {
    const tokens = await oauth.exchangeCode(code, getTikTokRedirectUri(request.url, config.redirectUri));
    if (missingTikTokScopes(tokens.scope ?? params.get("scopes")).length) {
      // Don't keep a half-permitted grant around.
      await oauth.revoke(tokens.access_token).catch(() => false);
      return finish(request, "missing_scopes");
    }
    await saveTikTokConnection(tokens);
  } catch (error) {
    console.error("TikTok OAuth callback failed", error);
    return finish(request, "error");
  }

  revalidatePath("/settings");
  revalidatePath("/publishing");
  return finish(request, "connected");
}
