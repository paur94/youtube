import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleContent } from "@/test/fixtures";

import { DEFAULT_MODEL, describeClaudeError, getClaudeConfig, runStoryGeneration } from "./claude";

const request = { model: DEFAULT_MODEL, effort: "medium" as const, system: "system", user: "user" };
const apiUsage = {
  input_tokens: 1200,
  output_tokens: 5400,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// Stands in for client.beta.messages.stream(); only the members runStoryGeneration uses.
function fakeClient(finalMessage: () => Promise<unknown>, currentMessage?: unknown) {
  const stream = vi.fn((body: Record<string, unknown>) => {
    void body;
    return { finalMessage, currentMessage };
  });
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream };
}

describe("runStoryGeneration", () => {
  it("returns parsed content with usage and sends the expected request", async () => {
    const { client, stream } = fakeClient(async () => ({
      model: DEFAULT_MODEL,
      stop_reason: "end_turn",
      usage: apiUsage,
      parsed_output: sampleContent,
    }));

    const result = await runStoryGeneration(client, request);

    expect(result).toMatchObject({
      ok: true,
      content: sampleContent,
      model: DEFAULT_MODEL,
      usage: { inputTokens: 1200, outputTokens: 5400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const body = stream.mock.calls[0][0];
    expect(body).toMatchObject({
      model: DEFAULT_MODEL,
      system: "system",
      messages: [{ role: "user", content: "user" }],
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
      output_config: { effort: "medium", format: expect.objectContaining({ type: "json_schema" }) },
    });
    expect(body).not.toHaveProperty("temperature");
  });

  it("reports a refusal with its category", async () => {
    const { client } = fakeClient(async () => ({
      model: DEFAULT_MODEL,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: null },
      usage: apiUsage,
      parsed_output: null,
    }));
    const result = await runStoryGeneration(client, request);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("general_harms") });
    expect(result.usage?.outputTokens).toBe(5400);
  });

  it("keeps billed usage when truncated output fails to parse", async () => {
    const snapshot = { model: DEFAULT_MODEL, stop_reason: "max_tokens", usage: apiUsage };
    const { client } = fakeClient(async () => {
      throw new Anthropic.AnthropicError("Failed to parse structured output");
    }, snapshot);
    const result = await runStoryGeneration(client, request);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("cut off"),
      usage: { outputTokens: 5400 },
    });
  });

  it("maps API errors to actionable messages without usage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Anthropic.APIError.generate(401, undefined, "invalid x-api-key", new Headers());
    const { client } = fakeClient(async () => {
      throw error;
    });
    const result = await runStoryGeneration(client, request);
    expect(result).toMatchObject({
      ok: false,
      usage: null,
      model: DEFAULT_MODEL,
      message: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
  });
});

describe("describeClaudeError", () => {
  const make = (status: number) => Anthropic.APIError.generate(status, undefined, "message", new Headers());

  it.each([
    [429, "rate limit"],
    [404, "not found"],
    [403, "not allowed"],
    [529, "temporarily unavailable"],
    [500, "temporarily unavailable"],
  ])("status %i", (status, text) => {
    expect(describeClaudeError(make(status), DEFAULT_MODEL).toLowerCase()).toContain(text);
  });

  it("handles connection failures and unknown errors", () => {
    expect(describeClaudeError(new Anthropic.APIConnectionError({ message: "offline" }), DEFAULT_MODEL)).toContain(
      "internet",
    );
    expect(describeClaudeError(new Error("boom"), DEFAULT_MODEL)).toContain("unexpectedly");
  });
});

describe("getClaudeConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is unconfigured without a key and falls back to defaults", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    vi.stubEnv("ANTHROPIC_EFFORT", "turbo");
    expect(getClaudeConfig()).toEqual({ configured: false, model: DEFAULT_MODEL, effort: "medium" });
  });

  it("reads overrides from the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("ANTHROPIC_EFFORT", "high");
    expect(getClaudeConfig()).toEqual({ configured: true, model: "claude-sonnet-5-5", effort: "high" });
  });
});
