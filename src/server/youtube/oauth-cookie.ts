import "server-only";

import { timingSafeEqual } from "node:crypto";

// Short-lived, httpOnly cookie that ties the Google callback to the browser that started the flow
// (state, against CSRF) and carries the PKCE verifier. It is scoped to the callback route.

export const OAUTH_COOKIE = "yt_oauth";
export const OAUTH_COOKIE_PATH = "/api/youtube";
export const OAUTH_COOKIE_MAX_AGE = 600;

export function packOAuthCookie(state: string, verifier: string) {
  return `${state}.${verifier}`;
}

/** The PKCE verifier when `returnedState` matches the cookie, otherwise null. */
export function verifyOAuthCookie(cookie: string | undefined, returnedState: string | null) {
  if (!cookie || !returnedState) return null;
  const [state, verifier] = cookie.split(".");
  if (!state || !verifier) return null;
  const a = Buffer.from(state);
  const b = Buffer.from(returnedState);
  return a.length === b.length && timingSafeEqual(a, b) ? verifier : null;
}
