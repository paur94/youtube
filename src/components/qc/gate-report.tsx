"use client";

import { CircleCheckIcon, EyeOffIcon, RotateCcwIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GATE_GROUP_LABELS, GATE_GROUPS, type GateBeat, type GateCheck, type GateEvaluation } from "@/lib/generation-qc";
import { cn } from "@/lib/utils";

import { SeverityIcon } from "./qc-issue-list";

const ORDER = { critical: 0, warning: 1, passed: 2 } as const;

export function GateCounts({ evaluation }: { evaluation: Pick<GateEvaluation, "critical" | "warnings" | "passed"> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-3 text-xs tabular-nums">
      <span className={cn("inline-flex items-center gap-1", evaluation.critical.length ? "text-rose-300" : "text-muted-foreground")}>
        <SeverityIcon severity="critical" className="size-3.5" />
        {evaluation.critical.length} critical
      </span>
      <span className={cn("inline-flex items-center gap-1", evaluation.warnings.length ? "text-amber-300" : "text-muted-foreground")}>
        <SeverityIcon severity="warning" className="size-3.5" />
        {evaluation.warnings.length} warning{evaluation.warnings.length === 1 ? "" : "s"}
      </span>
      <span className="inline-flex items-center gap-1 text-emerald-300">
        <CircleCheckIcon className="size-3.5" />
        {evaluation.passed.length} passed
      </span>
    </span>
  );
}

/** The planned beats as a bar over the clip length, then as a list. */
export function BeatTimeline({ beats, seconds }: { beats: GateBeat[]; seconds: number }) {
  if (!beats.length) return null;
  const total = Math.max(seconds, ...beats.map((b) => b.endSeconds), 0.1);
  return (
    <div className="grid gap-1.5">
      <div className="relative h-5 overflow-hidden rounded bg-muted" aria-hidden>
        {beats.map((b, i) => (
          <div
            key={i}
            className={cn("absolute inset-y-0 border-r border-background", b.endSeconds > seconds + 0.25 ? "bg-rose-500/60" : i % 2 ? "bg-primary/45" : "bg-primary/70")}
            style={{ left: `${(b.startSeconds / total) * 100}%`, width: `${((b.endSeconds - b.startSeconds) / total) * 100}%` }}
            title={`${b.startSeconds}-${b.endSeconds}s`}
          />
        ))}
        {total > seconds && <div className="absolute inset-y-0 border-l-2 border-rose-400" style={{ left: `${(seconds / total) * 100}%` }} />}
      </div>
      <ol className="grid gap-0.5 text-xs">
        {beats.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span className={cn("shrink-0 font-mono tabular-nums text-muted-foreground", b.endSeconds > seconds + 0.25 && "text-rose-300")}>
              {b.startSeconds}-{b.endSeconds}s
            </span>
            <span>{b.action}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CheckItem({ check, dismissed, onDismiss, pending }: { check: GateCheck; dismissed: boolean; onDismiss?: (id: string, dismissed: boolean) => void; pending?: boolean }) {
  const canDismiss = onDismiss && check.status !== "passed" && !check.hard;
  return (
    <li className={cn("flex items-start gap-2 rounded-md border p-2 text-sm", dismissed && "opacity-55")}>
      {check.status === "passed" ? (
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-label="Passed" />
      ) : (
        <SeverityIcon severity={check.status} className="mt-0.5" />
      )}
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className={cn("font-medium", dismissed && "line-through")}>
          {check.label}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{check.source === "ai" ? "AI review" : "Rule"}</span>
          {dismissed && <span className="ml-1 text-xs font-normal text-muted-foreground">· dismissed</span>}
        </p>
        {check.detail && <p className="text-xs text-muted-foreground">{check.detail}</p>}
        {check.fix && check.status !== "passed" && <p className="text-xs">Fix: {check.fix}</p>}
      </div>
      {canDismiss && (
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={pending}
          title={dismissed ? "Restore" : "Dismiss after checking it yourself"}
          aria-label={dismissed ? "Restore check" : "Dismiss check"}
          onClick={() => onDismiss(check.id, !dismissed)}
        >
          {dismissed ? <RotateCcwIcon /> : <EyeOffIcon />}
        </Button>
      )}
    </li>
  );
}

/**
 * The pre-generation QA report: every check grouped by area, critical first, passed checks folded away.
 * With `onDismiss`, warnings and soft critical issues can be dismissed after a person checked them.
 */
export function GateReport({
  evaluation,
  clipSeconds,
  onDismiss,
  pending,
}: {
  evaluation: GateEvaluation;
  clipSeconds: number;
  onDismiss?: (id: string, dismissed: boolean) => void;
  pending?: boolean;
}) {
  const dismissedIds = new Set(evaluation.dismissed.map((c) => c.id));
  const review = evaluation.review;
  return (
    <div className="grid gap-3">
      {review?.summary && <p className="rounded-md border bg-muted/30 p-2.5 text-sm">{review.summary}</p>}
      {GATE_GROUPS.map((group) => {
        const items = evaluation.checks.filter((c) => c.group === group).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
        if (!items.length) return null;
        const open = items.filter((c) => c.status !== "passed");
        const passed = items.filter((c) => c.status === "passed");
        return (
          <section key={group} className="grid gap-1.5">
            <h4 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {GATE_GROUP_LABELS[group]}
              {!open.some((c) => !dismissedIds.has(c.id)) && <Badge variant="outline" className="text-emerald-300">passed</Badge>}
            </h4>
            {open.length > 0 && (
              <ul className="grid gap-1.5">
                {open.map((c) => (
                  <CheckItem key={c.id} check={c} dismissed={dismissedIds.has(c.id)} onDismiss={onDismiss} pending={pending} />
                ))}
              </ul>
            )}
            {passed.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  {passed.length} passed check{passed.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-1.5 grid gap-1.5">
                  {passed.map((c) => (
                    <CheckItem key={c.id} check={c} dismissed={false} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
      {review && review.beats.length > 0 && (
        <section className="grid gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Planned timeline ({clipSeconds}s clip)</h4>
          <BeatTimeline beats={review.beats} seconds={clipSeconds} />
        </section>
      )}
      {review && review.frames.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">What the reviewer saw in each image</summary>
          <ul className="mt-1.5 grid gap-1">
            {review.frames.map((f, i) => (
              <li key={i}>
                <span className="font-medium">{f.image}:</span> {f.description}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
