import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

import { createGoogleOAuthClient, getRedirectUri, getYouTubeConfig, YouTubeError } from "@/server/providers/youtube";
import { missingScopes, saveYouTubeConnection } from "@/server/youtube/connection";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, verifyOAuthCookie } from "@/server/youtube/oauth-cookie";

// Google redirects here after the consent screen. Only a fixed outcome code is passed on to the
// Settings page, never text from the request, so nothing user-controlled is reflected.
function finish(request: NextRequest, outcome: string) {
  const response = NextResponse.redirect(new URL(`/settings?youtube=${outcome}`, request.url));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const verifier = verifyOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value, params.get("state"));
  if (!verifier) return finish(request, "invalid_state");
  if (params.get("error")) return finish(request, params.get("error") === "access_denied" ? "denied" : "error");

  const code = params.get("code");
  const config = getYouTubeConfig();
  if (!config.configured) return finish(request, "not_configured");
  if (!code) return finish(request, "error");

  try {
    const tokens = await createGoogleOAuthClient(config).exchangeCode(code, verifier, getRedirectUri(request.url, config.redirectUri));
    if (missingScopes(tokens.scope).length) {
      // Don't keep a half-permitted grant around.
      await createGoogleOAuthClient(config).revoke(tokens.refresh_token ?? tokens.access_token).catch(() => false);
      return finish(request, "missing_scopes");
    }
    await saveYouTubeConnection(tokens);
  } catch (error) {
    console.error("YouTube OAuth callback failed", error);
    const noChannel = error instanceof YouTubeError && error.reason === "youtubeSignupRequired";
    return finish(request, noChannel ? "no_channel" : "error");
  }

  revalidatePath("/settings");
  revalidatePath("/publishing");
  return finish(request, "connected");
}
