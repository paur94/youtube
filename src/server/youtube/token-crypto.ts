import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// OAuth tokens are stored AES-256-GCM encrypted so a database dump alone can't act on the channel.
// Format: "v1.<iv>.<auth tag>.<ciphertext>", each part base64url.

const VERSION = "v1";

/** 32-byte key from YOUTUBE_TOKEN_KEY: base64 of 32 bytes, or any passphrase of 32+ characters. */
export function deriveTokenKey(secret: string) {
  const trimmed = secret.trim();
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return decoded;
  if (trimmed.length < 32) throw new Error("YOUTUBE_TOKEN_KEY must be 32 random bytes in base64, or at least 32 characters.");
  return createHash("sha256").update(trimmed).digest();
}

export function encryptToken(plain: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

/** Throws when the value was encrypted with a different key or was tampered with. */
export function decryptToken(sealed: string, key: Buffer) {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognised token format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
