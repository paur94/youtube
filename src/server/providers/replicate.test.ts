import { describe, expect, it, vi } from "vitest";

import { createReplicateClient, ReplicateError } from "./replicate";

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
  const client = createReplicateClient({ apiToken: "r8_token", fetch: fetch as typeof globalThis.fetch, sleep });
  const call = (i: number) => {
    const [url, init] = fetch.mock.calls[i];
    return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
  };
  return { client, fetch, sleep, call };
}

const PATH = "/models/alibaba/wan-3/predictions";

describe("Replicate client", () => {
  it("creates a prediction with bearer auth and the input wrapped in { input }", async () => {
    const { client, call } = setup(json({ id: "pred_1", status: "starting" }, 201));
    const result = await client.createPrediction(PATH, { prompt: "A fox runs", duration: 5 });
    expect(result).toEqual({ id: "pred_1", status: "starting", error: null });
    const { url, init, headers } = call(0);
    expect(url).toBe("https://api.replicate.com/v1/models/alibaba/wan-3/predictions");
    expect(init.method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer r8_token");
    expect(JSON.parse(String(init.body))).toEqual({ input: { prompt: "A fox runs", duration: 5 } });
  });

  it("retries a submit only when Replicate rejected it, never after a network error", async () => {
    const limited = setup(json({ detail: "slow down" }, 429), json({ id: "pred_2", status: "starting" }, 201));
    await expect(limited.client.createPrediction(PATH, {})).resolves.toMatchObject({ id: "pred_2" });
    expect(limited.fetch).toHaveBeenCalledTimes(2);

    // A lost response may still have started a billed prediction, so it isn't resent.
    const offline = setup(new TypeError("fetch failed"));
    await expect(offline.client.createPrediction(PATH, {})).rejects.toBeInstanceOf(ReplicateError);
    expect(offline.fetch).toHaveBeenCalledTimes(1);

    const broken = setup(json({ detail: "boom" }, 500));
    await expect(broken.client.createPrediction(PATH, {})).rejects.toThrow("server error");
    expect(broken.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries status checks on server errors", async () => {
    const { client, fetch } = setup(
      json({}, 503),
      json({ id: "pred_1", status: "failed", error: { message: "bad input" } }),
    );
    const result = await client.getPrediction("pred_1");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("bad input");
  });

  it("maps errors to readable messages with the API detail", async () => {
    const { client } = setup(json({ title: "Invalid", detail: "duration: must be <= 30" }, 422));
    await expect(client.createPrediction(PATH, {})).rejects.toThrow("duration: must be <= 30");
    const noCredit = setup(json({ detail: "Insufficient credit" }, 402));
    await expect(noCredit.client.createPrediction(PATH, {})).rejects.toThrow("no credit");
  });

  it("uploads files as multipart content and returns urls.get", async () => {
    const { client, call } = setup(json({ id: "f1", urls: { get: "https://api.replicate.com/v1/files/f1" } }, 201));
    const url = await client.uploadFile(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(url).toBe("https://api.replicate.com/v1/files/f1");
    const { url: endpoint, init } = call(0);
    expect(endpoint).toBe("https://api.replicate.com/v1/files");
    const file = (init.body as FormData).get("content") as File;
    expect(file.name).toBe("input.jpg");
    expect(file.type).toBe("image/jpeg");
  });

  it("cancels a prediction", async () => {
    const { client, call } = setup(json({ id: "pred_1", status: "canceled" }));
    await client.cancel("pred_1");
    expect(call(0).url).toBe("https://api.replicate.com/v1/predictions/pred_1/cancel");
  });
});
