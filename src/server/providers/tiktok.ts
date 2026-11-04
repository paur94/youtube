import "server-only";

import { randomBytes } from "node:crypto";

import { z } from "zod";

import { TIKTOK_PRIVACY_LEVELS, type TikTokPrivacyLevel, tikTokChunkRanges } from "@/lib/tiktok";

// TikTok Login Kit (web) + Content Posting API, Direct Post. Everything here follows TikTok's docs:
// - Consent: GET www.tiktok.com/v2/auth/authorize/ (client_key, comma-separated scope, state). The
//   redirect URI must be https and registered exactly; there is no PKCE for web apps.
// - Tokens: POST open.tiktokapis.com/v2/oauth/token/ (authorization_code | refresh_token); revoke: /v2/oauth/revoke/.
//   Access tokens last 2 hours, refresh tokens 180 days, and every refresh rotates the refresh token.
// - Posting: POST /v2/post/publish/creator_info/query/ before every post, then /v2/post/publish/video/init/
//   (FILE_UPLOAD), PUT the chunks to upload_url, and poll /v2/post/publish/status/fetch/.
// - Errors: API calls answer { data, error: { code, message, log_id } } with code "ok" on success;
//   OAuth calls answer { error, error_description, log_id }.
// - Unaudited apps can only post SELF_ONLY, to private accounts, for at most 5 users a day.
// The client secret and tokens stay on the server: nothing in this file may be imported by client code.

export const TIKTOK_AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API_URL = "https://open.tiktokapis.com";

/** Read the profile, and post videos. Nothing broader. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish"] as const;

export const TIKTOK_CALLBACK_PATH = "/api/tiktok/callback";

export const TIKTOK_NOT_CONFIGURED_MESSAGE =
  "TikTok is not configured. Add TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and TIKTOK_TOKEN_KEY to .env.local and restart the server.";

export function getTikTokConfig() {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim() ?? "";
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET?.trim() ?? "";
  const tokenKey = process.env.TIKTOK_TOKEN_KEY?.trim() ?? "";
  const redirectUri = process.env.TIKTOK_REDIRECT_URI?.trim() || null;
  const missing = [
    !clientKey && "TIKTOK_CLIENT_KEY",
    !clientSecret && "TIKTOK_CLIENT_SECRET",
    !tokenKey && "TIKTOK_TOKEN_KEY",
  ].filter((m): m is string => Boolean(m));
  return { clientKey, clientSecret, tokenKey, redirectUri, configured: missing.length === 0, missing };
}

/** The registered redirect URI: TIKTOK_REDIRECT_URI, or this app's own origin (which must then be https). */
export function getTikTokRedirectUri(requestUrl: string, configured: string | null) {
  return configured ?? new URL(TIKTOK_CALLBACK_PATH, requestUrl).toString();
}

// ---------- OAuth ----------

export function createTikTokState() {
  return randomBytes(24).toString("base64url");
}

export function buildTikTokAuthorizationUrl(input: { clientKey: string; redirectUri: string; state: string }) {
  const url = new URL(TIKTOK_AUTH_URL);
  url.search = new URLSearchParams({
    client_key: input.clientKey,
    response_type: "code",
    scope: TIKTOK_SCOPES.join(","),
    redirect_uri: input.redirectUri,
    state: input.state,
    // Always show the authorization page, so switching accounts works.
    disable_auto_auth: "1",
  }).toString();
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  open_id: z.string().min(1),
  refresh_token: z.string().min(1),
  refresh_expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export type TikTokTokens = z.infer<typeof tokenSchema>;

export class TikTokError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "TikTokError";
  }

  /** The stored authorization no longer works: the user has to connect the account again. */
  get needsReconnect() {
    return this.code === "invalid_grant" || this.code === "access_token_invalid" || this.code === "scope_not_authorized";
  }
}

/** Maps an HTTP status and TikTok error code to a user-facing message. */
export function describeTikTokError(status: number | null, code: string | null, detail?: string) {
  const suffix = detail ? ` (${detail})` : "";
  switch (code) {
    case "invalid_grant":
    case "access_token_invalid":
      return "TikTok access was revoked or expired. Reconnect the account in Settings.";
    case "invalid_client":
      return "TikTok rejected the app credentials. Check TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET.";
    case "scope_not_authorized":
      return "The connection lacks posting permission. Reconnect the account and allow every requested permission.";
    case "spam_risk_too_many_posts":
      return "This TikTok account reached its daily post limit. Retry tomorrow.";
    case "spam_risk_user_banned_from_posting":
      return "TikTok has blocked this account from posting. Check the account in the TikTok app.";
    case "reached_active_user_cap":
      return "This TikTok app reached its daily limit of posting users. Retry tomorrow.";
    case "unaudited_client_can_only_post_to_private_accounts":
      return "Until TikTok audits this app, it can only post to a private account. Set the account to private in the TikTok app, or get the app audited.";
    case "privacy_level_option_mismatch":
      return "TikTok rejected that visibility for this account. Reopen the dialog and choose again.";
    case "rate_limit_exceeded":
      return "TikTok is rate limiting this app. Wait a minute and retry.";
  }
  switch (status) {
    case null:
      return "Could not reach TikTok. Check your connection and retry.";
    case 400:
      return `TikTok rejected the request${suffix}.`;
    case 401:
      return "TikTok rejected the stored authorization. Reconnect the account in Settings.";
    case 403:
      return `TikTok refused the request${suffix}.`;
    case 429:
      return "TikTok is rate limiting this app. Wait a minute and retry.";
    default:
      return status >= 500 ? `TikTok had a server error (HTTP ${status}). Retry later.` : `TikTok returned HTTP ${status}${suffix}.`;
  }
}

/** Messages for the fail_reason of a post that TikTok couldn't process. */
export function describeTikTokFailReason(reason: string | undefined) {
  switch (reason) {
    case "file_format_check_failed":
      return "TikTok couldn't read the video file. Re-render it as H.264 MP4.";
    case "duration_check_failed":
      return "The video is too long or too short for this TikTok account.";
    case "frame_rate_check_failed":
      return "TikTok needs 23 to 60 frames per second.";
    case "picture_size_check_failed":
      return "TikTok needs a resolution between 360 and 4096 pixels on each side.";
    case "publish_cancelled":
      return "The post was cancelled in TikTok.";
    case "auth_removed":
      return "The app's access was removed in TikTok. Reconnect the account.";
    case "spam_risk_too_many_posts":
    case "spam_risk_user_banned_from_posting":
      return describeTikTokError(403, reason);
    case "spam_risk_text":
      return "TikTok flagged the caption. Change it and retry.";
    case "spam_risk":
      return "TikTok flagged the post as spam risk.";
    case "internal":
      return "TikTok had an internal error processing the post. Retry.";
    default:
      return `TikTok couldn't publish the post${reason ? ` (${reason})` : ""}.`;
  }
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: string | { code?: unknown; message?: unknown };
      error_description?: unknown;
    };
    if (typeof body.error === "string") {
      return { code: body.error, detail: typeof body.error_description === "string" ? body.error_description.slice(0, 300) : undefined };
    }
    return {
      code: typeof body.error?.code === "string" ? body.error.code : null,
      detail: typeof body.error?.message === "string" ? body.error.message.slice(0, 300) : undefined,
    };
  } catch {
    return { code: null, detail: undefined };
  }
}

async function toError(response: Response) {
  const { code, detail } = await readError(response);
  return new TikTokError(describeTikTokError(response.status, code, detail), response.status, code);
}

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs = 30_000) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch {
    throw new TikTokError(describeTikTokError(null, null), null);
  }
}

async function parse<T>(response: Response, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new TikTokError("TikTok returned a response this app doesn't recognise.", response.status);
  return parsed.data;
}

export type TikTokOAuthOptions = { clientKey: string; clientSecret: string; fetch?: typeof fetch };

export function createTikTokOAuthClient(options: TikTokOAuthOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const form = { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" };

  async function token(params: Record<string, string>) {
    const response = await send(fetchImpl, `${TIKTOK_API_URL}/v2/oauth/token/`, {
      method: "POST",
      headers: form,
      body: new URLSearchParams({ client_key: options.clientKey, client_secret: options.clientSecret, ...params }),
    });
    // OAuth errors can come back with HTTP 200 and an `error` field instead of tokens.
    const body = (await response.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (!response.ok || (body && typeof body.error === "string" && body.error)) throw await toError(response);
    return parse(response, tokenSchema);
  }

  return {
    exchangeCode(code: string, redirectUri: string) {
      return token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    },

    refresh(refreshToken: string) {
      return token({ grant_type: "refresh_token", refresh_token: refreshToken });
    },

    /** Revokes the grant at TikTok. Best effort: a token that is already invalid is fine. */
    async revoke(accessToken: string) {
      const response = await send(fetchImpl, `${TIKTOK_API_URL}/v2/oauth/revoke/`, {
        method: "POST",
        headers: form,
        body: new URLSearchParams({ client_key: options.clientKey, client_secret: options.clientSecret, token: accessToken }),
      });
      return response.ok;
    },
  };
}

// ---------- Content Posting API ----------

const envelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, error: z.object({ code: z.string(), message: z.string().optional() }).optional() });

const creatorInfoSchema = z.object({
  creator_avatar_url: z.string().optional(),
  creator_username: z.string().optional(),
  creator_nickname: z.string().optional(),
  privacy_level_options: z.array(z.string()),
  comment_disabled: z.boolean().optional(),
  duet_disabled: z.boolean().optional(),
  stitch_disabled: z.boolean().optional(),
  max_video_post_duration_sec: z.number().optional(),
});

const initSchema = z.object({ publish_id: z.string().min(1), upload_url: z.string().optional() });

const statusSchema = z.object({
  status: z.string(),
  fail_reason: z.string().optional(),
  // Spelled this way in TikTok's API.
  publicaly_available_post_id: z.array(z.union([z.number(), z.string()])).optional(),
  uploaded_bytes: z.number().optional(),
});

export type TikTokCreatorInfo = {
  username: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSeconds: number | null;
};

export type TikTokPostInfo = {
  title: string;
  privacyLevel: TikTokPrivacyLevel;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContent: boolean;
  brandOrganic: boolean;
  isAigc: boolean;
};

export type TikTokClientOptions = { accessToken: string; fetch?: typeof fetch };

export function createTikTokClient(options: TikTokClientOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const auth = { Authorization: `Bearer ${options.accessToken}` };

  async function postRaw<T>(path: string, body: unknown, schema: z.ZodType<T>) {
    const response = await send(fetchImpl, `${TIKTOK_API_URL}${path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toError(response);
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Reported below as an unrecognised response.
    }
    const parsed = envelope(schema).safeParse(json);
    if (!parsed.success) throw new TikTokError("TikTok returned a response this app doesn't recognise.", response.status);
    const { data, error } = parsed.data;
    if (error && error.code !== "ok") {
      throw new TikTokError(describeTikTokError(response.status, error.code, error.message), response.status, error.code);
    }
    return { data, text };
  }

  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>) => (await postRaw(path, body, schema)).data;

  return {
    /** Who will receive the post and what they may choose. TikTok requires a fresh query before each post. */
    async getCreatorInfo(): Promise<TikTokCreatorInfo> {
      const info = await post("/v2/post/publish/creator_info/query/", {}, creatorInfoSchema);
      return {
        username: info.creator_username ?? null,
        nickname: info.creator_nickname ?? null,
        avatarUrl: info.creator_avatar_url ?? null,
        privacyLevelOptions: info.privacy_level_options.filter((o): o is TikTokPrivacyLevel =>
          (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(o),
        ),
        commentDisabled: info.comment_disabled ?? false,
        duetDisabled: info.duet_disabled ?? false,
        stitchDisabled: info.stitch_disabled ?? false,
        maxDurationSeconds: info.max_video_post_duration_sec ?? null,
      };
    },

    /**
     * Starts a Direct Post and uploads the file in chunks. Not retried automatically: once the last
     * chunk is accepted TikTok starts publishing, and a retry would post the video twice.
     */
    async postVideo(input: { postInfo: TikTokPostInfo; bytes: Uint8Array; contentType: string }) {
      const size = input.bytes.byteLength;
      const ranges = tikTokChunkRanges(size);
      const p = input.postInfo;
      const init = await post(
        "/v2/post/publish/video/init/",
        {
          post_info: {
            title: p.title,
            privacy_level: p.privacyLevel,
            disable_comment: p.disableComment,
            disable_duet: p.disableDuet,
            disable_stitch: p.disableStitch,
            brand_content_toggle: p.brandContent,
            brand_organic_toggle: p.brandOrganic,
            is_aigc: p.isAigc,
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: ranges[0].end - ranges[0].start,
            total_chunk_count: ranges.length,
          },
        },
        initSchema,
      );
      if (!init.upload_url?.startsWith("https://")) throw new TikTokError("TikTok didn't return an upload URL.", 200);

      for (const { start, end } of ranges) {
        const chunk = input.bytes.subarray(start, end);
        const put = await send(
          fetchImpl,
          init.upload_url,
          {
            method: "PUT",
            headers: {
              // fetch sets Content-Length from the byte body.
              "Content-Type": input.contentType,
              "Content-Range": `bytes ${start}-${end - 1}/${size}`,
            },
            body: chunk as BodyInit,
          },
          10 * 60_000,
        );
        if (put.status !== 201 && put.status !== 206) {
          throw new TikTokError(describeTikTokError(put.status, null, `chunk at byte ${start}`), put.status);
        }
      }
      return { publishId: init.publish_id };
    },

    async getPostStatus(publishId: string) {
      const { data, text } = await postRaw("/v2/post/publish/status/fetch/", { publish_id: publishId }, statusSchema);
      // Post ids are 19-digit int64s that JSON.parse would round, so take the digits from the raw text.
      const exact = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/.exec(text)?.[1];
      return {
        status: data.status,
        failReason: data.fail_reason ?? null,
        postId: exact ?? (data.publicaly_available_post_id?.[0] !== undefined ? String(data.publicaly_available_post_id[0]) : null),
      };
    },
  };
}

export type TikTokClient = ReturnType<typeof createTikTokClient>;
