import "server-only";

import { desc, eq, ne } from "drizzle-orm";

import { db } from "@/db";
import { youtubeConnections } from "@/db/schema";
import {
  createGoogleOAuthClient,
  createYouTubeClient,
  getYouTubeConfig,
  type GoogleTokens,
  YOUTUBE_NOT_CONFIGURED_MESSAGE,
  YOUTUBE_SCOPES,
  YouTubeError,
} from "@/server/providers/youtube";

import { decryptToken, deriveTokenKey, encryptToken } from "./token-crypto";

const RECONNECT = "The stored YouTube authorization can't be used. Reconnect the channel in Settings.";

function requireConfig() {
  const config = getYouTubeConfig();
  if (!config.configured) throw new YouTubeError(YOUTUBE_NOT_CONFIGURED_MESSAGE, null);
  return { ...config, key: deriveTokenKey(config.tokenKey) };
}

/** Scopes the user actually granted; they can untick permissions on the consent screen. */
export function missingScopes(granted: string | undefined) {
  const have = new Set((granted ?? "").split(" ").filter(Boolean));
  return YOUTUBE_SCOPES.filter((s) => !have.has(s));
}

/** Public details of the connected channel: safe to render. Never includes tokens. */
export async function getYouTubeConnection() {
  const [row] = await db
    .select({
      channelId: youtubeConnections.channelId,
      channelTitle: youtubeConnections.channelTitle,
      channelHandle: youtubeConnections.channelHandle,
      thumbnailUrl: youtubeConnections.thumbnailUrl,
      scopes: youtubeConnections.scopes,
      connectedAt: youtubeConnections.connectedAt,
    })
    .from(youtubeConnections)
    .orderBy(desc(youtubeConnections.connectedAt))
    .limit(1);
  return row ?? null;
}

export type YouTubeConnectionSummary = NonNullable<Awaited<ReturnType<typeof getYouTubeConnection>>>;

/** Finishes the OAuth flow: stores the channel and its encrypted tokens, replacing any other channel. */
export async function saveYouTubeConnection(tokens: GoogleTokens) {
  const config = requireConfig();
  if (!tokens.refresh_token) throw new YouTubeError("Google didn't return a refresh token. Try connecting again.", null);
  const channel = await createYouTubeClient({ accessToken: tokens.access_token }).getMyChannel();
  const values = {
    channelId: channel.id,
    channelTitle: channel.title,
    channelHandle: channel.handle,
    thumbnailUrl: channel.thumbnailUrl,
    scopes: (tokens.scope ?? "").split(" ").filter(Boolean),
    refreshToken: encryptToken(tokens.refresh_token, config.key),
    accessToken: encryptToken(tokens.access_token, config.key),
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    connectedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.delete(youtubeConnections).where(ne(youtubeConnections.channelId, channel.id));
    await tx.insert(youtubeConnections).values(values).onConflictDoUpdate({ target: youtubeConnections.channelId, set: values });
  });
  return channel;
}

/** A valid access token for the connected channel, refreshed when it is about to expire. */
export async function getYouTubeAccessToken() {
  const config = requireConfig();
  const [row] = await db.select().from(youtubeConnections).orderBy(desc(youtubeConnections.connectedAt)).limit(1);
  if (!row) throw new YouTubeError("No YouTube channel is connected. Connect one in Settings.", null);

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refreshToken, config.key);
    if (row.accessToken && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
      return { accessToken: decryptToken(row.accessToken, config.key), channelId: row.channelId };
    }
  } catch {
    // YOUTUBE_TOKEN_KEY changed since the channel was connected.
    throw new YouTubeError(RECONNECT, null);
  }

  const tokens = await createGoogleOAuthClient(config).refresh(refreshToken);
  await db
    .update(youtubeConnections)
    .set({
      accessToken: encryptToken(tokens.access_token, config.key),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      // Google may rotate the refresh token.
      ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token, config.key) } : {}),
    })
    .where(eq(youtubeConnections.id, row.id));
  return { accessToken: tokens.access_token, channelId: row.channelId };
}

export async function getYouTubeClient() {
  const { accessToken } = await getYouTubeAccessToken();
  return createYouTubeClient({ accessToken });
}

/** Revokes the grant at Google (best effort) and forgets the channel. */
export async function deleteYouTubeConnection() {
  const rows = await db.select().from(youtubeConnections);
  const config = getYouTubeConfig();
  if (config.configured) {
    const oauth = createGoogleOAuthClient(config);
    for (const row of rows) {
      try {
        await oauth.revoke(decryptToken(row.refreshToken, deriveTokenKey(config.tokenKey)));
      } catch (error) {
        console.warn("Revoking the YouTube token failed; remove the app at myaccount.google.com/permissions", error);
      }
    }
  }
  await db.delete(youtubeConnections);
  return rows.length;
}
