import { type NextRequest, NextResponse } from "next/server";

import { buildAuthorizationUrl, createOAuthState, getRedirectUri, getYouTubeConfig } from "@/server/providers/youtube";
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, OAUTH_COOKIE_PATH, packOAuthCookie } from "@/server/youtube/oauth-cookie";

// Starts the Google OAuth consent flow. The client secret never reaches the browser: only the
// public client id, the redirect URI and the PKCE challenge go into the consent URL.
export async function GET(request: NextRequest) {
  const config = getYouTubeConfig();
  if (!config.configured) return NextResponse.redirect(new URL("/settings?youtube=not_configured", request.url));

  const { state, verifier, challenge } = createOAuthState();
  const redirectUri = getRedirectUri(request.url, config.redirectUri);
  const response = NextResponse.redirect(buildAuthorizationUrl({ clientId: config.clientId, redirectUri, state, challenge }));
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OAUTH_COOKIE, packOAuthCookie(state, verifier), {
    httpOnly: true,
    // "lax" so the cookie comes back on Google's top-level redirect to the callback.
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  return response;
}
