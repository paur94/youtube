import { describe, expect, it, vi } from "vitest";

import { createHedraClient, HedraError } from "./hedra";

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
  const client = createHedraClient({ apiKey: "kid:secret", fetch: fetch as typeof globalThis.fetch, sleep });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
  };
  return { client, fetch, sleep, call };
}

const accepted = {
  job_id: "job_123",
  model: "hedra-character-3",
  status: "IN_QUEUE",
  status_url: "/v3/jobs/job_123/status",
  result_url: "/v3/jobs/job_123",
};

describe("Hedra client", () => {
  it("submits the input with key auth and the idempotency key in the body", async () => {
    const { client, call } = setup(json(accepted, 202));
    const input = { prompt: "A duck sings", aspect_ratio: "16:9", resolution: "540p" };
    const result = await client.submit("hedra-character-3", input, "key-1");

    expect(result.job_id).toBe("job_123");
    const { url, init, headers } = call(0);
    expect(url).toBe("https://api.hedra.com/v3/models/hedra-character-3");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({ Authorization: "Key kid:secret", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ input, idempotency_key: "key-1" });
  });

  it("uploads files as multipart and returns the handle url", async () => {
    const { client, call } = setup(
      json({ url: "https://files.hedra.com/u/1?sig=abc", content_type: "audio/mpeg", expires_at: "2026-10-29T12:00:00Z" }),
    );
    const url = await client.uploadFile(new Uint8Array([1, 2, 3]), "audio/mpeg", "line.mp3");

    expect(url).toBe("https://files.hedra.com/u/1?sig=abc");
    const { url: endpoint, init, headers } = call(0);
    expect(endpoint).toBe("https://api.hedra.com/v3/files");
    expect(headers).not.toHaveProperty("Content-Type");
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("line.mp3");
    expect(file.type).toBe("audio/mpeg");
    expect(file.size).toBe(3);
  });

  it("reads job results", async () => {
    const { client, call } = setup(json({ status: "COMPLETED", outputs: [{ status: "COMPLETED", url: "https://x/out.mp4" }] }));
    const job = await client.getJob("job_123");
    expect(job.outputs?.[0].url).toBe("https://x/out.mp4");
    expect(call(0).url).toBe("https://api.hedra.com/v3/jobs/job_123");
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const { client, fetch, sleep } = setup(new TypeError("fetch failed"), json({ error: { code: "INTERNAL" } }, 500), json(accepted, 202));
    await client.submit("hedra-character-3", { prompt: "p" }, "k");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("explains wallet and moderation errors without retrying", async () => {
    const { client, fetch } = setup(json({ error: { code: "INSUFFICIENT_BALANCE", message: "Top up" } }, 402));
    const error = await client.submit("hedra-character-3", { prompt: "p" }, "k").catch((e) => e);
    expect(error).toBeInstanceOf(HedraError);
    expect(error).toMatchObject({ status: 402, retryable: false });
    expect(error.message).toMatch(/wallet/);
    expect(fetch).toHaveBeenCalledTimes(1);

    const moderated = setup(json({ error: { code: "MODERATION_FAILED", message: "Refused" } }, 422));
    const refused = await moderated.client.submit("hedra-character-3", { prompt: "p" }, "k").catch((e) => e);
    expect(refused.message).toMatch(/moderation refused the content \(Refused\)/);
  });

  it("rejects responses it doesn't recognise", async () => {
    const { client } = setup(json({ unexpected: true }, 202));
    await expect(client.submit("hedra-character-3", { prompt: "p" }, "k")).rejects.toThrow(/doesn't recognise/);
  });
});
