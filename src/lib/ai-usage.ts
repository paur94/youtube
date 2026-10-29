// Token usage and cost *estimates*. Actual billing is in the Anthropic Console; these numbers use
// published first-party list prices and can drift when prices change.

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type Pricing = {
  /** USD per million tokens. */
  input: number;
  output: number;
  /** Omitted where the cache-read price isn't known; estimates then require zero cache reads. */
  cacheRead?: number;
};

export const PRICING_AS_OF = "October 2026";

// Anthropic first-party API list prices (USD / 1M tokens).
const PRICING: Record<string, Pricing> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
};

// 5-minute cache writes are billed at 1.25x the input price.
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Returns null when the model's price isn't known, rather than guessing. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICING[model];
  if (!price) return null;
  if (usage.cacheReadTokens > 0 && price.cacheRead === undefined) return null;

  const perToken = (usd: number) => usd / 1_000_000;
  return (
    usage.inputTokens * perToken(price.input) +
    usage.outputTokens * perToken(price.output) +
    usage.cacheReadTokens * perToken(price.cacheRead ?? 0) +
    usage.cacheWriteTokens * perToken(price.input * CACHE_WRITE_MULTIPLIER)
  );
}

export function hasKnownPricing(model: string) {
  return model in PRICING;
}

export function formatUsd(value: number) {
  if (value > 0 && value < 0.01) return "< $0.01";
  return `$${value.toFixed(2)}`;
}

const tokenFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(value: number) {
  return tokenFormat.format(value);
}

type UsageRow = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/** Totals for a set of generation rows. `costUsd` covers only rows with known pricing. */
export function summarizeUsage(rows: UsageRow[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let unpricedCalls = 0;

  for (const row of rows) {
    const usage: TokenUsage = {
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens ?? 0,
      cacheWriteTokens: row.cacheWriteTokens ?? 0,
    };
    inputTokens += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    outputTokens += usage.outputTokens;
    if (row.inputTokens === null) continue; // the call failed before any usage was reported
    const cost = estimateCostUsd(row.model, usage);
    if (cost === null) unpricedCalls++;
    else costUsd += cost;
  }

  return { calls: rows.length, inputTokens, outputTokens, costUsd, unpricedCalls };
}

export type UsageSummary = ReturnType<typeof summarizeUsage>;
