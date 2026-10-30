import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { packOAuthCookie, verifyOAuthCookie } from "./oauth-cookie";
import { decryptToken, deriveTokenKey, encryptToken } from "./token-crypto";

describe("token encryption", () => {
  const key = deriveTokenKey(randomBytes(32).toString("base64"));

  it("round-trips and never stores the plain token", () => {
    const sealed = encryptToken("1//refresh-token", key);
    expect(sealed).not.toContain("refresh-token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptToken(sealed, key)).toBe("1//refresh-token");
    expect(encryptToken("1//refresh-token", key)).not.toBe(sealed);
  });

  it("rejects a different key or tampered data", () => {
    const sealed = encryptToken("secret", key);
    expect(() => decryptToken(sealed, deriveTokenKey(randomBytes(32).toString("base64")))).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("other").toString("base64url");
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });

  it("accepts long passphrases and refuses short ones", () => {
    expect(deriveTokenKey("a passphrase that is definitely 32+ chars")).toHaveLength(32);
    expect(() => deriveTokenKey("short")).toThrow(/YOUTUBE_TOKEN_KEY/);
  });
});

describe("OAuth state cookie", () => {
  it("returns the verifier only for the matching state", () => {
    const cookie = packOAuthCookie("state1", "verifier1");
    expect(verifyOAuthCookie(cookie, "state1")).toBe("verifier1");
    expect(verifyOAuthCookie(cookie, "state2")).toBeNull();
    expect(verifyOAuthCookie(cookie, null)).toBeNull();
    expect(verifyOAuthCookie(undefined, "state1")).toBeNull();
  });
});
