// Outcomes of the TikTok OAuth callback, shown on the Settings page. The callback passes only these codes.
export const TIKTOK_CONNECT_OUTCOMES = {
  connected: { ok: true, message: "TikTok account connected." },
  denied: { ok: false, message: "You cancelled TikTok's authorization screen. Nothing was connected." },
  missing_scopes: { ok: false, message: "Allow every requested permission (profile and video posting) to connect the account." },
  invalid_state: { ok: false, message: "The sign-in link expired or didn't come from this app. Start again from Settings." },
  not_configured: { ok: false, message: "Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_TOKEN_KEY in .env.local, then restart." },
  error: { ok: false, message: "Connecting to TikTok failed. Check the server log and the TikTok app settings, then retry." },
} as const satisfies Record<string, { ok: boolean; message: string }>;

export type TikTokConnectOutcome = keyof typeof TIKTOK_CONNECT_OUTCOMES;

export function parseTikTokConnectOutcome(value: unknown): TikTokConnectOutcome | null {
  return typeof value === "string" && Object.hasOwn(TIKTOK_CONNECT_OUTCOMES, value) ? (value as TikTokConnectOutcome) : null;
}

export const TIKTOK_PRIVACY_LEVELS = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export const TIKTOK_POST_STATES = ["uploading", "processing", "published", "failed"] as const;
export type TikTokPostState = (typeof TIKTOK_POST_STATES)[number];

export const TIKTOK_CAPTION_MAX = 2200;

/** The suggested caption: title, description, then any hashtags the text doesn't contain yet. Editable before posting. */
export function buildTikTokCaption(input: { title: string; description: string; hashtags: string[] }) {
  const body = [input.title.trim(), input.description.trim()].filter(Boolean).join("\n\n");
  const lower = body.toLowerCase();
  const tags = input.hashtags.filter((t) => !lower.includes(t.toLowerCase()));
  const caption = tags.length ? `${body}\n\n${tags.join(" ")}` : body;
  return [...caption].length > TIKTOK_CAPTION_MAX ? [...caption].slice(0, TIKTOK_CAPTION_MAX).join("").trimEnd() : caption;
}

/** TikTok's Creator Rewards Program pays only for videos longer than one minute. */
export const CREATOR_REWARDS_MIN_SECONDS = 60;

export function creatorRewardsNote(durationSeconds: number | null) {
  if (durationSeconds === null) return null;
  return durationSeconds > CREATOR_REWARDS_MIN_SECONDS
    ? "Long enough for the Creator Rewards Program, once the account qualifies."
    : "Under 1 minute: it won't earn Creator Rewards, but it can grow followers.";
}

const MB = 1024 * 1024;

/**
 * Chunk layout for TikTok's FILE_UPLOAD: files up to 64 MB go in one request; larger ones in 32 MB
 * chunks, with the remainder merged into the last chunk (which may be up to 128 MB).
 */
export function planTikTokChunks(size: number) {
  if (size <= 0) throw new Error("The video file is empty");
  if (size <= 64 * MB) return { chunkSize: size, chunkCount: 1 };
  const chunkSize = 32 * MB;
  return { chunkSize, chunkCount: Math.floor(size / chunkSize) };
}

/** Byte ranges [start, end) for each chunk, in upload order. */
export function tikTokChunkRanges(size: number) {
  const { chunkSize, chunkCount } = planTikTokChunks(size);
  return Array.from({ length: chunkCount }, (_, i) => ({
    start: i * chunkSize,
    end: i === chunkCount - 1 ? size : (i + 1) * chunkSize,
  }));
}

/** TikTok's authorization lasts 180 days; warn two weeks before it runs out. */
export function authorizationExpiresSoon(refreshTokenExpiresAt: Date) {
  return refreshTokenExpiresAt.getTime() < Date.now() + 14 * 24 * 3600_000;
}

export function tikTokPostUrl(username: string | null, postId: string | null) {
  return username && postId ? `https://www.tiktok.com/@${username}/video/${postId}` : null;
}
