// Outcomes of the OAuth callback, shown on the Settings page. The callback passes only these codes.
export const YOUTUBE_CONNECT_OUTCOMES = {
  connected: { ok: true, message: "YouTube channel connected." },
  denied: { ok: false, message: "You cancelled the Google consent screen. Nothing was connected." },
  missing_scopes: { ok: false, message: "Allow every requested permission (upload and read-only access) to connect the channel." },
  no_channel: { ok: false, message: "That Google account has no YouTube channel. Create one in YouTube, then connect again." },
  invalid_state: { ok: false, message: "The sign-in link expired or didn't come from this app. Start again from Settings." },
  not_configured: { ok: false, message: "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and YOUTUBE_TOKEN_KEY in .env.local, then restart." },
  error: { ok: false, message: "Connecting to YouTube failed. Check the server log and the OAuth client settings, then retry." },
} as const satisfies Record<string, { ok: boolean; message: string }>;

export type YouTubeConnectOutcome = keyof typeof YOUTUBE_CONNECT_OUTCOMES;

export function parseConnectOutcome(value: unknown): YouTubeConnectOutcome | null {
  return typeof value === "string" && Object.hasOwn(YOUTUBE_CONNECT_OUTCOMES, value) ? (value as YouTubeConnectOutcome) : null;
}
