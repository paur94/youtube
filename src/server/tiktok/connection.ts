import "server-only";

import { desc, eq, ne } from "drizzle-orm";

import { db } from "@/db";
import { tiktokConnections } from "@/db/schema";
import {
  createTikTokClient,
  createTikTokOAuthClient,
  getTikTokConfig,
  TIKTOK_NOT_CONFIGURED_MESSAGE,
  TIKTOK_SCOPES,
  TikTokError,
  type TikTokTokens,
} from "@/server/providers/tiktok";
import { decryptToken, deriveTokenKey, encryptToken } from "@/server/youtube/token-crypto";

const RECONNECT = "The stored TikTok authorization can't be used. Reconnect the account in Settings.";

function requireConfig() {
  const config = getTikTokConfig();
  if (!config.configured) throw new TikTokError(TIKTOK_NOT_CONFIGURED_MESSAGE, null);
  return { ...config, key: deriveTokenKey(config.tokenKey, "TIKTOK_TOKEN_KEY") };
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** Scopes the user didn't grant; they can untick permissions on TikTok's authorization screen. */
export function missingTikTokScopes(granted: string | null | undefined) {
  const have = new Set((granted ?? "").split(/[,\s]+/).filter(Boolean));
  return TIKTOK_SCOPES.filter((s) => !have.has(s));
}

/** Public details of the connected account: safe to render. Never includes tokens. */
export async function getTikTokConnection() {
  const [row] = await db
    .select({
      openId: tiktokConnections.openId,
      username: tiktokConnections.username,
      displayName: tiktokConnections.displayName,
      avatarUrl: tiktokConnections.avatarUrl,
      refreshTokenExpiresAt: tiktokConnections.refreshTokenExpiresAt,
      connectedAt: tiktokConnections.connectedAt,
    })
    .from(tiktokConnections)
    .orderBy(desc(tiktokConnections.connectedAt))
    .limit(1);
  return row ?? null;
}

export type TikTokConnectionSummary = NonNullable<Awaited<ReturnType<typeof getTikTokConnection>>>;

/** Finishes the OAuth flow: stores the account and its encrypted tokens, replacing any other account. */
export async function saveTikTokConnection(tokens: TikTokTokens) {
  const config = requireConfig();
  const creator = await createTikTokClient({ accessToken: tokens.access_token }).getCreatorInfo();
  const values = {
    openId: tokens.open_id,
    username: creator.username,
    displayName: creator.nickname ?? creator.username ?? "TikTok account",
    avatarUrl: creator.avatarUrl,
    scopes: (tokens.scope ?? "").split(/[,\s]+/).filter(Boolean),
    refreshToken: encryptToken(tokens.refresh_token, config.key),
    refreshTokenExpiresAt: expiresAt(tokens.refresh_expires_in),
    accessToken: encryptToken(tokens.access_token, config.key),
    accessTokenExpiresAt: expiresAt(tokens.expires_in),
    connectedAt: new Date(),
  };
  await db.transaction(async (tx) => {
    await tx.delete(tiktokConnections).where(ne(tiktokConnections.openId, tokens.open_id));
    await tx.insert(tiktokConnections).values(values).onConflictDoUpdate({ target: tiktokConnections.openId, set: values });
  });
  return values;
}

// TikTok rotates the refresh token on every refresh and rejects the old one, so two refreshes must
// never run at once in this process.
let refreshing: Promise<{ accessToken: string; openId: string }> | null = null;

/** A valid access token for the connected account, refreshed when it is about to expire. */
export async function getTikTokAccessToken(): Promise<{ accessToken: string; openId: string }> {
  const config = requireConfig();
  const [row] = await db.select().from(tiktokConnections).orderBy(desc(tiktokConnections.connectedAt)).limit(1);
  if (!row) throw new TikTokError("No TikTok account is connected. Connect one in Settings.", null);

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refreshToken, config.key);
    if (row.accessToken && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() > Date.now() + 5 * 60_000) {
      return { accessToken: decryptToken(row.accessToken, config.key), openId: row.openId };
    }
  } catch {
    // TIKTOK_TOKEN_KEY changed since the account was connected.
    throw new TikTokError(RECONNECT, null);
  }
  if (row.refreshTokenExpiresAt.getTime() < Date.now()) throw new TikTokError(RECONNECT, null, "invalid_grant");

  refreshing ??= (async () => {
    try {
      const tokens = await createTikTokOAuthClient(config).refresh(refreshToken);
      await db
        .update(tiktokConnections)
        .set({
          accessToken: encryptToken(tokens.access_token, config.key),
          accessTokenExpiresAt: expiresAt(tokens.expires_in),
          refreshToken: encryptToken(tokens.refresh_token, config.key),
          refreshTokenExpiresAt: expiresAt(tokens.refresh_expires_in),
        })
        .where(eq(tiktokConnections.id, row.id));
      return { accessToken: tokens.access_token, openId: row.openId };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function getTikTokClient() {
  const { accessToken, openId } = await getTikTokAccessToken();
  return { client: createTikTokClient({ accessToken }), openId };
}

/** Revokes the grant at TikTok (best effort) and forgets the account. */
export async function deleteTikTokConnection() {
  const rows = await db.select().from(tiktokConnections);
  const config = getTikTokConfig();
  if (config.configured) {
    const oauth = createTikTokOAuthClient(config);
    for (const row of rows) {
      try {
        if (row.accessToken) await oauth.revoke(decryptToken(row.accessToken, deriveTokenKey(config.tokenKey, "TIKTOK_TOKEN_KEY")));
      } catch (error) {
        console.warn("Revoking the TikTok token failed; remove the app under TikTok Settings > Security > Manage app permissions", error);
      }
    }
  }
  await db.delete(tiktokConnections);
  return rows.length;
}
