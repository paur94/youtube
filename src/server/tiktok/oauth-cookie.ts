import "server-only";

import { timingSafeEqual } from "node:crypto";

// Short-lived, httpOnly cookie that ties TikTok's callback to the browser that started the flow
// (state, against CSRF). TikTok's web flow has no PKCE, so the state is all it carries.

export const TIKTOK_OAUTH_COOKIE = "tt_oauth";
export const TIKTOK_OAUTH_COOKIE_PATH = "/api/tiktok";
export const TIKTOK_OAUTH_COOKIE_MAX_AGE = 600;

export function verifyTikTokState(cookie: string | undefined, returnedState: string | null) {
  if (!cookie || !returnedState) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(returnedState);
  return a.length === b.length && timingSafeEqual(a, b);
}
