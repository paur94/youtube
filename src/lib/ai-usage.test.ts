import { describe, expect, it } from "vitest";

import { estimateCostUsd, formatUsd, summarizeUsage } from "./ai-usage";

const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("estimateCostUsd", () => {
  it("uses list prices for known models", () => {
    // $4 / MTok input + $20 / MTok output for Claude Opus 5.5
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 2);
  });

  it("returns null instead of guessing for unknown models", () => {
    expect(estimateCostUsd("some-future-model", usage)).toBeNull();
  });

  it("returns null when cache reads are present but their price is unknown", () => {
    expect(estimateCostUsd("claude-opus-5", { ...usage, cacheReadTokens: 10 })).toBeNull();
  });
});

describe("summarizeUsage", () => {
  it("totals tokens; cost excludes failed calls without usage and unpriced models", () => {
    const summary = summarizeUsage([
      { model: "claude-opus-5-5", inputTokens: 2000, outputTokens: 8000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { model: "claude-opus-5-5", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
      { model: "mystery-model", inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(summary).toMatchObject({ calls: 3, inputTokens: 3000, outputTokens: 9000, unpricedCalls: 1 });
    expect(summary.costUsd).toBeCloseTo((2000 * 4 + 8000 * 20) / 1_000_000);
  });

  it("formats small amounts", () => {
    expect(formatUsd(0.004)).toBe("< $0.01");
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});
