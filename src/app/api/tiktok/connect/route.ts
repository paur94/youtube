import { type NextRequest, NextResponse } from "next/server";

import { buildTikTokAuthorizationUrl, createTikTokState, getTikTokConfig, getTikTokRedirectUri } from "@/server/providers/tiktok";
import { TIKTOK_OAUTH_COOKIE, TIKTOK_OAUTH_COOKIE_MAX_AGE, TIKTOK_OAUTH_COOKIE_PATH } from "@/server/tiktok/oauth-cookie";

// Starts TikTok's authorization flow. The client secret never reaches the browser: only the public
// client key, the redirect URI and the state go into the authorization URL.
export async function GET(request: NextRequest) {
  const config = getTikTokConfig();
  if (!config.configured) return NextResponse.redirect(new URL("/settings?tiktok=not_configured", request.url));

  const state = createTikTokState();
  const redirectUri = getTikTokRedirectUri(request.url, config.redirectUri);
  const response = NextResponse.redirect(buildTikTokAuthorizationUrl({ clientKey: config.clientKey, redirectUri, state }));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(TIKTOK_OAUTH_COOKIE, state, {
    httpOnly: true,
    // "lax" so the cookie comes back on TikTok's top-level redirect to the callback.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: TIKTOK_OAUTH_COOKIE_PATH,
    maxAge: TIKTOK_OAUTH_COOKIE_MAX_AGE,
  });
  return response;
}
