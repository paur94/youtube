import { describe, expect, it, vi } from "vitest";

import { createHiggsfieldClient, describeHiggsfieldError, getHiggsfieldConfig, HiggsfieldError } from "./higgsfield";

const queued = {
  status: "queued",
  request_id: "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff",
  status_url: "https://api.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/status",
  cancel_url: "https://api.higgsfield.ai/requests/d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff/cancel",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function setup(...responses: (Response | Error)[]) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const client = createHiggsfieldClient({ keyId: "id", keySecret: "secret", fetch: fetch as typeof globalThis.fetch, sleep });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
  };
  return { client, fetch, sleep, call };
}

describe("Higgsfield client", () => {
  it("submits with key auth, JSON body and the idempotency key", async () => {
    const { client, call } = setup(json(queued));
    const result = await client.submit("/higgsfield-ai/soul/standard", { prompt: "duck" }, "key-1");

    expect(result.request_id).toBe(queued.request_id);
    const { url, init, headers } = call(0);
    expect(url).toBe("https://api.higgsfield.ai/higgsfield-ai/soul/standard");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({
      Authorization: "Key id:secret",
      "Content-Type": "application/json",
      "Idempotency-Key": "key-1",
    });
    expect(JSON.parse(String(init.body))).toEqual({ prompt: "duck" });
  });

  it("retries 5xx and network errors with the same idempotency key", async () => {
    const { client, fetch, sleep, call } = setup(new TypeError("fetch failed"), json({ detail: "boom" }, 503), json(queued));
    await client.submit("/m", { prompt: "duck" }, "key-2");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(call(2).headers["Idempotency-Key"]).toBe("key-2");
  });

  it("honours Retry-After on 429", async () => {
    const { client, sleep } = setup(json({ detail: "account_queue_full" }, 429, { "retry-after": "3" }), json(queued));
    await client.submit("/m", { prompt: "duck" }, "k");
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("does not retry auth or balance errors and explains them", async () => {
    const { client, fetch } = setup(json({ detail: "Invalid credentials" }, 401));
    const error = await client.submit("/m", { prompt: "duck" }, "k").catch((e) => e);
    expect(error).toBeInstanceOf(HiggsfieldError);
    expect(error).toMatchObject({ status: 401, retryable: false });
    expect(error.message).toMatch(/HF_API_KEY_ID/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt", async () => {
    const { client, fetch } = setup(json({}, 500), json({}, 502), json({ detail: "still down" }, 500));
    await expect(client.submit("/m", {}, "k")).rejects.toMatchObject({ status: 500, retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reads status responses and rejects unknown shapes", async () => {
    const { client, call } = setup(
      json({ status: "completed", request_id: "r1", images: [{ url: "https://cdn/x.jpg" }], expires_at: null }),
      json({ unexpected: true }),
    );
    const status = await client.getStatus("r1");
    expect(status.images?.[0].url).toBe("https://cdn/x.jpg");
    expect(call(0).url).toBe("https://api.higgsfield.ai/requests/r1/status");
    expect(call(0).init.method).toBe("GET");
    await expect(client.getStatus("r1")).rejects.toThrow(/recognise/);
  });

  it("returns an estimate in USD or null when unavailable", async () => {
    const { client, call } = setup(json({ usd: "0.094" }), json({ detail: "Not Found" }, 404));
    expect(await client.estimate("/higgsfield-ai/soul/v2/standard", { prompt: "x" })).toBeCloseTo(0.094);
    expect(call(0).url).toBe("https://api.higgsfield.ai/estimate/higgsfield-ai/soul/v2/standard");
    expect(await client.estimate("/kling-video/v2.5-turbo/pro/text-to-video", { prompt: "x" })).toBeNull();
  });

  it("uploads to the presigned URL without sending credentials", async () => {
    const { client, call } = setup(
      json({
        public_url: "https://files.higgsfield.ai/a.png",
        upload_url: "https://storage.example.com/a.png?sig=1",
        content_type: "image/png",
        upload_headers: { "Content-Type": "image/png", "x-amz-tagging": "t=1" },
      }),
      new Response(null, { status: 200 }),
    );
    const url = await client.uploadFile(new Uint8Array([1, 2, 3]), "image/png");
    expect(url).toBe("https://files.higgsfield.ai/a.png");
    expect(JSON.parse(String(call(0).init.body))).toEqual({ content_type: "image/png" });
    expect(call(1).init.method).toBe("PUT");
    expect(call(1).headers).toEqual({ "Content-Type": "image/png", "x-amz-tagging": "t=1" });
  });

  it("cancels without retrying", async () => {
    const { client, fetch } = setup(json({ detail: "already started" }, 400));
    await expect(client.cancel("r1")).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("configuration", () => {
  it("needs both key parts", () => {
    vi.stubEnv("HF_API_KEY_ID", "id");
    vi.stubEnv("HF_API_KEY_SECRET", "");
    expect(getHiggsfieldConfig().configured).toBe(false);
    vi.stubEnv("HF_API_KEY_SECRET", "secret");
    expect(getHiggsfieldConfig().configured).toBe(true);
    vi.unstubAllEnvs();
  });

  it("maps documented status codes to guidance", () => {
    expect(describeHiggsfieldError(403)).toMatch(/balance/);
    expect(describeHiggsfieldError(null)).toMatch(/reach/);
    expect(describeHiggsfieldError(422, "bad duration")).toMatch(/bad duration/);
  });
});
