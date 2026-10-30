import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

// Google OAuth 2.0 for web server apps + YouTube Data API v3. Everything here follows Google's docs:
// - Consent: GET accounts.google.com/o/oauth2/v2/auth (code flow, PKCE S256, access_type=offline)
// - Tokens: POST oauth2.googleapis.com/token (authorization_code | refresh_token); revoke: POST /revoke
// - Channel: GET /youtube/v3/channels?part=snippet&mine=true
// - Upload: resumable videos.insert. POST the metadata to /upload/youtube/v3/videos?uploadType=resumable,
//   then PUT the file bytes to the session URI from the Location header
// - Errors: { error: { code, message, errors: [{ reason }] } }; OAuth errors: { error, error_description }
// The client secret and tokens stay on the server: nothing in this file may be imported by client code.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

/** Upload videos, and read the channel and the status of its videos. Nothing broader. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
] as const;

export const YOUTUBE_CALLBACK_PATH = "/api/youtube/callback";

export const YOUTUBE_NOT_CONFIGURED_MESSAGE =
  "YouTube is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and YOUTUBE_TOKEN_KEY to .env.local and restart the server.";

export function getYouTubeConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const tokenKey = process.env.YOUTUBE_TOKEN_KEY?.trim() ?? "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || null;
  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !tokenKey && "YOUTUBE_TOKEN_KEY",
  ].filter((m): m is string => Boolean(m));
  return { clientId, clientSecret, tokenKey, redirectUri, configured: missing.length === 0, missing };
}

/** The registered redirect URI: GOOGLE_REDIRECT_URI, or this app's own origin. */
export function getRedirectUri(requestUrl: string, configured: string | null) {
  return configured ?? new URL(YOUTUBE_CALLBACK_PATH, requestUrl).toString();
}

// ---------- OAuth ----------

export function createOAuthState() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    state: randomBytes(24).toString("base64url"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function buildAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    // A refresh token so uploads keep working after the hour-long access token expires.
    access_type: "offline",
    // Always show the consent screen (and the channel picker), which also guarantees a refresh token.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type GoogleTokens = z.infer<typeof tokenSchema>;

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "YouTubeError";
  }

  /** The stored authorization no longer works: the user has to connect the channel again. */
  get needsReconnect() {
    return this.reason === "invalid_grant" || this.status === 401;
  }
}

/** Maps an HTTP status and Google error reason to a user-facing message. */
export function describeYouTubeError(status: number | null, reason: string | null, detail?: string) {
  const suffix = detail ? ` (${detail})` : "";
  switch (reason) {
    case "invalid_grant":
      return "YouTube access was revoked or expired. Reconnect the channel in Settings.";
    case "invalid_client":
    case "unauthorized_client":
      return "Google rejected the OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.";
    case "quotaExceeded":
      return "The YouTube API daily quota is used up. Retry after midnight Pacific time, or upload in YouTube Studio.";
    case "uploadLimitExceeded":
      return "This channel has reached YouTube's upload limit for now. Retry later.";
    case "youtubeSignupRequired":
      return "This Google account has no YouTube channel yet. Create one, then reconnect.";
    case "invalidPublishAt":
      return "YouTube rejected the scheduled time. Choose a later time and retry.";
    case "insufficientPermissions":
    case "ACCESS_TOKEN_SCOPE_INSUFFICIENT":
      return "The connection lacks upload permission. Reconnect the channel and allow every requested permission.";
  }
  switch (status) {
    case null:
      return "Could not reach YouTube. Check your connection and retry.";
    case 400:
      return `YouTube rejected the request${suffix}. Check the title, description and tags.`;
    case 401:
      return "YouTube rejected the stored authorization. Reconnect the channel in Settings.";
    case 403:
      return `YouTube refused the request${suffix}.`;
    case 429:
      return "YouTube is rate limiting this app. Retry in a moment.";
    default:
      return status >= 500 ? `YouTube had a server error (HTTP ${status}). Retry later.` : `YouTube returned HTTP ${status}${suffix}.`;
  }
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: string | { message?: unknown; errors?: { reason?: unknown }[]; status?: unknown };
      error_description?: unknown;
    };
    if (typeof body.error === "string") {
      return { reason: body.error, detail: typeof body.error_description === "string" ? body.error_description.slice(0, 300) : undefined };
    }
    const reason = body.error?.errors?.[0]?.reason;
    return {
      reason: typeof reason === "string" ? reason : typeof body.error?.status === "string" ? body.error.status : null,
      detail: typeof body.error?.message === "string" ? body.error.message.slice(0, 300) : undefined,
    };
  } catch {
    return { reason: null, detail: undefined };
  }
}

async function toError(response: Response) {
  const { reason, detail } = await readError(response);
  return new YouTubeError(describeYouTubeError(response.status, reason, detail), response.status, reason);
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs = 30_000) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch {
    throw new YouTubeError(describeYouTubeError(null, null), null);
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new YouTubeError("YouTube returned a response this app doesn't recognise.", response.status);
  return parsed.data;
}

export type OAuthClientOptions = { clientId: string; clientSecret: string; fetch?: typeof fetch };

export function createGoogleOAuthClient(options: OAuthClientOptions) {
  const fetchImpl = options.fetch ?? fetch;

  async function token(params: Record<string, string>) {
    const response = await send(fetchImpl, GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...params }),
    });
    if (!response.ok) throw await toError(response);
    return parse(response, tokenSchema);
  }

  return {
    exchangeCode(code: string, verifier: string, redirectUri: string) {
      return token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
    },

    refresh(refreshToken: string) {
      return token({ grant_type: "refresh_token", refresh_token: refreshToken });
    },

    /** Revokes the grant at Google. Best effort: a token that is already invalid is fine. */
    async revoke(tokenValue: string) {
      const response = await send(fetchImpl, GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenValue }),
      });
      return response.ok || response.status === 400;
    },
  };
}

// ---------- Data API ----------

const channelListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          customUrl: z.string().optional(),
          thumbnails: z.record(z.string(), z.object({ url: z.string() })).optional(),
        }),
      }),
    )
    .optional(),
});

const videoStatusSchema = z.object({
  uploadStatus: z.string().optional(),
  privacyStatus: z.string().optional(),
  publishAt: z.string().optional(),
  failureReason: z.string().optional(),
  rejectionReason: z.string().optional(),
});

const videoSchema = z.object({ id: z.string(), status: videoStatusSchema.optional() });

export type YouTubeVideo = z.infer<typeof videoSchema>;

export type YouTubeUploadMetadata = {
  snippet: Record<string, unknown>;
  status: Record<string, unknown>;
};

export type YouTubeClientOptions = { accessToken: string; fetch?: typeof fetch };

export function createYouTubeClient(options: YouTubeClientOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${options.accessToken}` };

  async function get<T>(path: string, schema: z.ZodType<T>) {
    const response = await send(fetchImpl, `${YOUTUBE_API_URL}${path}`, { headers: { ...auth, Accept: "application/json" } });
    if (!response.ok) throw await toError(response);
    return parse(response, schema);
  }

  return {
    async getMyChannel() {
      const list = await get("/channels?part=snippet&mine=true", channelListSchema);
      const channel = list.items?.[0];
      if (!channel) throw new YouTubeError(describeYouTubeError(403, "youtubeSignupRequired"), 403, "youtubeSignupRequired");
      const thumbs = channel.snippet.thumbnails ?? {};
      return {
        id: channel.id,
        title: channel.snippet.title,
        handle: channel.snippet.customUrl ?? null,
        thumbnailUrl: (thumbs.default ?? thumbs.medium ?? Object.values(thumbs)[0])?.url ?? null,
      };
    },

    /** Status of up to 50 videos; videos that no longer exist are missing from the result. */
    async getVideos(ids: string[]) {
      const params = new URLSearchParams({ part: "status", id: ids.join(","), maxResults: "50" });
      return (await get(`/videos?${params}`, z.object({ items: z.array(videoSchema).optional() }))).items ?? [];
    },

    /**
     * Uploads a video in one resumable session. Not retried automatically: if the final request
     * fails after YouTube received the bytes, a retry could create a duplicate video.
     */
    async uploadVideo(input: { metadata: YouTubeUploadMetadata; bytes: Uint8Array; contentType: string; notifySubscribers?: boolean }) {
      const params = new URLSearchParams({
        uploadType: "resumable",
        part: "snippet,status",
        notifySubscribers: String(input.notifySubscribers ?? true),
      });
      const start = await send(fetchImpl, `${YOUTUBE_UPLOAD_URL}?${params}`, {
        method: "POST",
        headers: {
          ...auth,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(input.bytes.byteLength),
          "X-Upload-Content-Type": input.contentType,
        },
        body: JSON.stringify(input.metadata),
      });
      if (!start.ok) throw await toError(start);
      const sessionUrl = start.headers.get("location");
      if (!sessionUrl?.startsWith("https://")) throw new YouTubeError("YouTube didn't return an upload session.", start.status);

      const put = await send(
        fetchImpl,
        sessionUrl,
        { method: "PUT", headers: { "Content-Type": input.contentType }, body: input.bytes as BodyInit },
        15 * 60_000,
      );
      if (!put.ok) throw await toError(put);
      return parse(put, videoSchema);
    },
  };
}

export type YouTubeClient = ReturnType<typeof createYouTubeClient>;
