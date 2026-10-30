import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizationUrl,
  createGoogleOAuthClient,
  createOAuthState,
  createYouTubeClient,
  getRedirectUri,
  YOUTUBE_SCOPES,
  YouTubeError,
} from "./youtube";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function mockFetch(...responses: (Response | Error)[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init!, headers: (init!.headers ?? {}) as Record<string, string> };
  };
  return { fetch: fetch as typeof globalThis.fetch, mock: fetch, call };
}

describe("OAuth consent", () => {
  it("asks for offline upload + read-only access with PKCE and state", () => {
    const { state, verifier, challenge } = createOAuthState();
    expect(verifier).not.toBe(challenge);
    const url = new URL(buildAuthorizationUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:3000/api/youtube/callback", state, challenge }));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      response_type: "code",
      access_type: "offline",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: YOUTUBE_SCOPES.join(" "),
    });
    // The secret never goes into the browser-facing URL.
    expect(url.toString()).not.toContain("secret");
  });

  it("derives the redirect URI from the request unless one is configured", () => {
    expect(getRedirectUri("http://127.0.0.1:3000/api/youtube/connect", null)).toBe("http://127.0.0.1:3000/api/youtube/callback");
    expect(getRedirectUri("http://127.0.0.1:3000/x", "https://studio.example/cb")).toBe("https://studio.example/cb");
  });
});

describe("Google OAuth client", () => {
  it("exchanges the code with the verifier and client secret in a form body", async () => {
    const { fetch, call } = mockFetch(json({ access_token: "at", expires_in: 3599, refresh_token: "rt", scope: YOUTUBE_SCOPES.join(" ") }));
    const tokens = await createGoogleOAuthClient({ clientId: "cid", clientSecret: "sec", fetch }).exchangeCode("code1", "ver1", "http://x/cb");

    expect(tokens).toMatchObject({ access_token: "at", refresh_token: "rt" });
    const { url, init } = call(0);
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: "cid",
      client_secret: "sec",
      grant_type: "authorization_code",
      code: "code1",
      code_verifier: "ver1",
      redirect_uri: "http://x/cb",
    });
  });

  it("reports a revoked refresh token as needing reconnection", async () => {
    const { fetch } = mockFetch(json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    const error = await createGoogleOAuthClient({ clientId: "c", clientSecret: "s", fetch })
      .refresh("rt")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(YouTubeError);
    expect((error as YouTubeError).needsReconnect).toBe(true);
    expect((error as YouTubeError).message).toContain("Reconnect");
  });
});

describe("YouTube client", () => {
  it("uploads in a resumable session: metadata first, then the bytes to the session URL", async () => {
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=xyz";
    const { fetch, call } = mockFetch(
      new Response(null, { status: 200, headers: { location: session } }),
      json({ id: "vid123", status: { uploadStatus: "uploaded", privacyStatus: "public" } }),
    );
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const metadata = { snippet: { title: "Hi" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: true } };
    const video = await createYouTubeClient({ accessToken: "at", fetch }).uploadVideo({ metadata, bytes, contentType: "video/mp4" });

    expect(video.id).toBe("vid123");
    const start = call(0);
    expect(start.url).toContain("uploadType=resumable");
    expect(start.url).toContain("part=snippet%2Cstatus");
    expect(start.headers).toMatchObject({ Authorization: "Bearer at", "X-Upload-Content-Length": "4", "X-Upload-Content-Type": "video/mp4" });
    expect(JSON.parse(String(start.init.body))).toEqual(metadata);
    const put = call(1);
    expect(put.url).toBe(session);
    expect(put.init.method).toBe("PUT");
    expect(put.init.body).toBe(bytes);
  });

  it("maps quota errors from the Data API", async () => {
    const { fetch, mock } = mockFetch(json({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403));
    const error = await createYouTubeClient({ accessToken: "at", fetch })
      .uploadVideo({ metadata: { snippet: {}, status: {} }, bytes: new Uint8Array(1), contentType: "video/mp4" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, reason: "quotaExceeded" });
    expect((error as Error).message).toContain("quota");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a failed upload on its own", async () => {
    const { fetch, mock } = mockFetch(
      new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/s" } }),
      new TypeError("socket hang up"),
    );
    await expect(
      createYouTubeClient({ accessToken: "at", fetch }).uploadVideo({ metadata: { snippet: {}, status: {} }, bytes: new Uint8Array(1), contentType: "video/mp4" }),
    ).rejects.toMatchObject({ status: null });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("reads the connected channel and flags accounts without one", async () => {
    const { fetch } = mockFetch(
      json({ items: [{ id: "UC1", snippet: { title: "Kids", customUrl: "@kids", thumbnails: { default: { url: "https://yt3/x.jpg" } } } }] }),
      json({ items: [] }),
    );
    const client = createYouTubeClient({ accessToken: "at", fetch });
    expect(await client.getMyChannel()).toEqual({ id: "UC1", title: "Kids", handle: "@kids", thumbnailUrl: "https://yt3/x.jpg" });
    await expect(client.getMyChannel()).rejects.toMatchObject({ reason: "youtubeSignupRequired" });
  });
});
