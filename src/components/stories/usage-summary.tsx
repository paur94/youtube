import { CircleXIcon } from "lucide-react";

import type { StoryGeneration } from "@/db/schema";
import {
  estimateCostUsd,
  formatTokens,
  formatUsd,
  PRICING_AS_OF,
  type UsageSummary,
} from "@/lib/ai-usage";

export function UsageStats({ usage }: { usage: UsageSummary }) {
  const stats = [
    { label: "API calls", value: String(usage.calls) },
    { label: "Input tokens", value: formatTokens(usage.inputTokens) },
    { label: "Output tokens", value: formatTokens(usage.outputTokens) },
    { label: "Est. cost", value: usage.calls - usage.unpricedCalls > 0 ? formatUsd(usage.costUsd) : "—" },
  ];

  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-2 gap-2">
        {stats.map(({ label, value }) => (
          <div key={label} className="rounded-lg border bg-background/40 px-3 py-2">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted-foreground">
        Token counts are reported by the Anthropic API. Costs are estimates at list prices (
        {PRICING_AS_OF}); see the Anthropic Console for actual billing.
        {usage.unpricedCalls > 0 &&
          ` ${usage.unpricedCalls} call(s) used a model without a known price and are excluded.`}
      </p>
    </div>
  );
}

const durationFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

export function GenerationLog({ generations }: { generations: StoryGeneration[] }) {
  if (generations.length === 0) return null;

  return (
    <ul className="grid gap-1.5 text-xs">
      {generations.slice(0, 5).map((g) => {
        const cost =
          g.inputTokens === null
            ? null
            : estimateCostUsd(g.model, {
                inputTokens: g.inputTokens,
                outputTokens: g.outputTokens ?? 0,
                cacheReadTokens: g.cacheReadTokens ?? 0,
                cacheWriteTokens: g.cacheWriteTokens ?? 0,
              });
        return (
          <li key={g.id} className="rounded-md border px-2.5 py-1.5">
            <div className="flex flex-wrap items-center justify-between gap-x-2">
              <span className="flex items-center gap-1 font-medium">
                {!g.ok && <CircleXIcon className="size-3 text-destructive" />}
                {g.model}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {durationFormat.format(g.durationMs / 1000)}s
              </span>
            </div>
            <p className="text-muted-foreground tabular-nums">
              {g.inputTokens === null
                ? "No usage reported"
                : `${formatTokens(g.inputTokens)} in · ${formatTokens(g.outputTokens ?? 0)} out`}
              {cost !== null && ` · ~${formatUsd(cost)}`}
            </p>
            {g.error && <p className="line-clamp-2 text-destructive">{g.error}</p>}
          </li>
        );
      })}
    </ul>
  );
}
