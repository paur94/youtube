import { describe, expect, it, vi } from "vitest";

import { buildTikTokCaption, planTikTokChunks, TIKTOK_CAPTION_MAX, tikTokChunkRanges } from "@/lib/tiktok";

import { buildTikTokAuthorizationUrl, createTikTokClient, createTikTokOAuthClient, TIKTOK_SCOPES, TikTokError } from "./tiktok";

const MB = 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init!, headers: (init!.headers ?? {}) as Record<string, string> };
  };
  return { fetch: fetch as typeof globalThis.fetch, mock: fetch, call };
}

const ok = (data: unknown) => json({ data, error: { code: "ok", message: "", log_id: "x" } });

describe("TikTok authorization", () => {
  it("asks for profile + posting scopes with state", () => {
    const url = new URL(buildTikTokAuthorizationUrl({ clientKey: "ck", redirectUri: "https://x.test/api/tiktok/callback", state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_key: "ck",
      response_type: "code",
      scope: TIKTOK_SCOPES.join(","),
      redirect_uri: "https://x.test/api/tiktok/callback",
      state: "s1",
    });
  });

  it("exchanges the code and treats an error body with HTTP 200 as a failure", async () => {
    const tokens = { access_token: "at", expires_in: 7200, open_id: "o1", refresh_token: "rt", refresh_expires_in: 15552000, scope: "user.info.basic,video.publish" };
    const { fetch, call } = mockFetch(json(tokens), json({ error: "invalid_grant", error_description: "bad code" }));
    const oauth = createTikTokOAuthClient({ clientKey: "ck", clientSecret: "cs", fetch });

    await expect(oauth.exchangeCode("c1", "https://x.test/cb")).resolves.toMatchObject({ open_id: "o1" });
    const body = new URLSearchParams(call(0).init.body as string);
    expect(call(0).url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect(Object.fromEntries(body)).toMatchObject({ client_key: "ck", client_secret: "cs", grant_type: "authorization_code", code: "c1" });

    const error = await oauth.refresh("old").catch((e) => e);
    expect(error).toBeInstanceOf(TikTokError);
    expect(error.needsReconnect).toBe(true);
  });
});

describe("TikTok posting", () => {
  it("reads creator info and maps API errors", async () => {
    const { fetch } = mockFetch(
      ok({
        creator_nickname: "Kids Tales",
        creator_username: "kidstales",
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY", "SOMETHING_NEW"],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: true,
        max_video_post_duration_sec: 600,
      }),
      json({ data: {}, error: { code: "spam_risk_too_many_posts", message: "cap" } }, 403),
    );
    const client = createTikTokClient({ accessToken: "at", fetch });
    await expect(client.getCreatorInfo()).resolves.toMatchObject({
      nickname: "Kids Tales",
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
      duetDisabled: true,
      maxDurationSeconds: 600,
    });
    await expect(client.getCreatorInfo()).rejects.toThrow(/daily post limit/);
  });

  it("inits a direct post and uploads the chunks in order", async () => {
    const size = 70 * MB;
    const { fetch, call, mock } = mockFetch(
      ok({ publish_id: "p1", upload_url: "https://open-upload.tiktokapis.com/upload?id=1" }),
      new Response(null, { status: 206 }),
      new Response(null, { status: 201 }),
    );
    const client = createTikTokClient({ accessToken: "at", fetch });
    const result = await client.postVideo({
      postInfo: {
        title: "Hi #kids",
        privacyLevel: "SELF_ONLY",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
        brandContent: false,
        brandOrganic: false,
        isAigc: true,
      },
      bytes: new Uint8Array(size),
      contentType: "video/mp4",
    });

    expect(result).toEqual({ publishId: "p1" });
    expect(mock).toHaveBeenCalledTimes(3);
    const init = JSON.parse(call(0).init.body as string);
    expect(call(0).headers.Authorization).toBe("Bearer at");
    expect(init.post_info).toMatchObject({ title: "Hi #kids", privacy_level: "SELF_ONLY", is_aigc: true });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: size, chunk_size: 32 * MB, total_chunk_count: 2 });
    expect(call(1).headers["Content-Range"]).toBe(`bytes 0-${32 * MB - 1}/${size}`);
    expect(call(2).headers["Content-Range"]).toBe(`bytes ${32 * MB}-${size - 1}/${size}`);
  });

  it("reads the post status without rounding the 64-bit post id", async () => {
    const raw = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7123456789012345678]},"error":{"code":"ok"}}';
    const { fetch } = mockFetch(new Response(raw, { headers: { "content-type": "application/json" } }));
    const client = createTikTokClient({ accessToken: "at", fetch });
    await expect(client.getPostStatus("p1")).resolves.toEqual({ status: "PUBLISH_COMPLETE", failReason: null, postId: "7123456789012345678" });
  });
});

describe("chunk plan", () => {
  it("sends small files whole and merges the remainder into the last chunk", () => {
    expect(planTikTokChunks(3 * MB)).toEqual({ chunkSize: 3 * MB, chunkCount: 1 });
    expect(planTikTokChunks(64 * MB)).toEqual({ chunkSize: 64 * MB, chunkCount: 1 });
    const ranges = tikTokChunkRanges(100 * MB + 5);
    expect(ranges).toHaveLength(3);
    expect(ranges.at(-1)).toEqual({ start: 64 * MB, end: 100 * MB + 5 });
    expect(ranges.at(-1)!.end - ranges.at(-1)!.start).toBeLessThanOrEqual(128 * MB);
  });
});

describe("caption", () => {
  it("adds only the hashtags the text lacks and respects the limit", () => {
    expect(buildTikTokCaption({ title: "The Brave Bunny", description: "A story #bedtime", hashtags: ["#bedtime", "#kids"] })).toBe(
      "The Brave Bunny\n\nA story #bedtime\n\n#kids",
    );
    expect([...buildTikTokCaption({ title: "x", description: "y".repeat(3000), hashtags: [] })]).toHaveLength(TIKTOK_CAPTION_MAX);
  });
});
