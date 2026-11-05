import { afterEach, describe, expect, it, vi } from "vitest";

import { storyContentSchema } from "@/lib/stories";
import { sampleContent } from "@/test/fixtures";

import { describeOpenAIError, getOpenAIConfig, runOpenAIStoryGeneration, toStrictJsonSchema, toUsage } from "./openai";

function sse(events: unknown[]) {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(new Blob([text]).stream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function finalResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: "gpt-6.1-sol",
    status: "completed",
    usage: { input_tokens: 1200, output_tokens: 3000, input_tokens_details: { cached_tokens: 200 } },
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(sampleContent) }] },
    ],
    ...overrides,
  };
}

const request = { model: "gpt-6.1-sol", effort: "medium" as const, system: "sys", user: "brief" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getOpenAIConfig", () => {
  it("defaults to GPT-6.1 Sol at medium effort and honours overrides", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("OPENAI_EFFORT", "");
    expect(getOpenAIConfig()).toEqual({ configured: true, model: "gpt-6.1-sol", effort: "medium" });
    vi.stubEnv("OPENAI_MODEL", "gpt-6.1-terra");
    vi.stubEnv("OPENAI_EFFORT", "high");
    expect(getOpenAIConfig()).toMatchObject({ model: "gpt-6.1-terra", effort: "high" });
    vi.stubEnv("OPENAI_EFFORT", "max");
    expect(getOpenAIConfig().effort).toBe("medium");
  });

  it("is not configured without a key", () => {
    vi.stubEnv("OPENAI_API_KEY", " ");
    expect(getOpenAIConfig().configured).toBe(false);
  });
});

describe("toStrictJsonSchema", () => {
  it("closes every object and requires all of its properties, including defaulted ones", () => {
    const schema = toStrictJsonSchema(storyContentSchema) as {
      $schema?: string;
      additionalProperties: boolean;
      required: string[];
      properties: { scenes: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(schema.$schema).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("reviewChecklist");
    expect(schema.properties.scenes.items.additionalProperties).toBe(false);
    expect(schema.properties.scenes.items.required).toContain("productionNotes");
    expect(JSON.stringify(schema)).not.toContain('"default"');
  });
});

describe("toUsage", () => {
  it("splits cached input out of the input count", () => {
    expect(toUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } })).toEqual({
      inputTokens: 600,
      outputTokens: 50,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    expect(toUsage(undefined)).toBeNull();
  });
});

describe("runOpenAIStoryGeneration", () => {
  it("sends a strict structured-output request and parses the streamed story", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      sse([{ type: "response.created", response: { status: "in_progress" } }, { type: "response.completed", response: finalResponse() }]),
    );
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch }, request);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.title).toBe(sampleContent.title);
    expect(result.model).toBe("gpt-6.1-sol");
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 3000, cacheReadTokens: 200, cacheWriteTokens: 0 });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-6.1-sol",
      instructions: "sys",
      input: "brief",
      reasoning: { effort: "medium" },
      stream: true,
      store: false,
      text: { format: { type: "json_schema", name: "story", strict: true } },
    });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("reports a refusal with the tokens that were billed", async () => {
    const refused = finalResponse({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([{ type: "response.completed", response: refused }]));
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch }, request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("declined to write this story");
    expect(result.usage?.outputTokens).toBe(3000);
  });

  it("explains a story cut off by the output limit", async () => {
    const cut = finalResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([{ type: "response.incomplete", response: cut }]));
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch }, request);
    expect(!result.ok && result.message).toContain("cut off");
  });

  it("rejects output that doesn't match the story schema", async () => {
    const bad = finalResponse({ output: [{ type: "message", content: [{ type: "output_text", text: '{"title":"x"}' }] }] });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async () => sse([{ type: "response.completed", response: bad }]));
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch }, request);
    expect(!result.ok && result.message).toContain("unexpected format");
  });

  it("retries rate limits and outages, but not quota or auth errors", async () => {
    const sleep = vi.fn(async () => {});
    const flaky = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "Rate limit reached" } }, { status: 429 }))
      .mockResolvedValueOnce(new Response("oops", { status: 503 }))
      .mockResolvedValueOnce(sse([{ type: "response.completed", response: finalResponse() }]));
    expect((await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch: flaky, sleep }, request)).ok).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const quota = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: "You exceeded your current quota" } }, { status: 429 }),
    );
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch: quota, sleep }, request);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(!result.ok && result.message).toContain("out of credit");
  });

  it("maps HTTP errors to actionable messages", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }));
    const result = await runOpenAIStoryGeneration({ apiKey: "sk-test", fetch }, request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(!result.ok && result.message).toContain("OPENAI_API_KEY");
    expect(describeOpenAIError(429, "m", "You exceeded your current quota")).toContain("out of credit");
    expect(describeOpenAIError(429, "m")).toContain("rate limit");
    expect(describeOpenAIError(404, "gpt-x")).toContain('"gpt-x"');
    expect(describeOpenAIError(null, "m")).toContain("Could not reach");
  });
});
