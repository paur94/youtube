"use client";

import { CircleXIcon, EyeOffIcon, InfoIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";

import { useAction } from "@/components/production/use-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatSeconds, QC_CATEGORY_LABELS, type QcIssue, type QcSeverity } from "@/lib/story-qc";
import { cn } from "@/lib/utils";
import { dismissQcIssue } from "@/server/actions/qc";

const SOURCE_LABELS: Record<QcIssue["source"], string> = { rules: "Script rule", ai: "Claude story check", vision: "Vision check" };

export function SeverityIcon({ severity, className }: { severity: QcSeverity; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  if (severity === "critical") return <CircleXIcon className={cn(base, "text-rose-400")} aria-label="Critical" />;
  if (severity === "warning") return <TriangleAlertIcon className={cn(base, "text-amber-400")} aria-label="Warning" />;
  return <InfoIcon className={cn(base, "text-sky-400")} aria-label="Info" />;
}

const ORDER: Record<QcSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Story QC findings, most severe first. With a `sceneId`, each issue can be dismissed after a person
 * checked it; dismissed issues stay listed, greyed out, and stop blocking generation and publishing.
 */
export function QcIssueList({
  issues,
  dismissed = [],
  sceneId,
  empty = "No issues found.",
  onSeek,
}: {
  issues: QcIssue[];
  dismissed?: string[];
  sceneId?: string | null;
  empty?: string;
  /** Jumps a video player to an issue's timestamp. */
  onSeek?: (seconds: number) => void;
}) {
  const [pending, run] = useAction();
  if (!issues.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const skip = new Set(dismissed);
  const sorted = [...issues].sort((a, b) => Number(skip.has(a.id)) - Number(skip.has(b.id)) || ORDER[a.severity] - ORDER[b.severity]);

  return (
    <ul className="grid gap-2">
      {sorted.map((i) => {
        const off = skip.has(i.id);
        return (
          <li key={i.id} className={cn("flex items-start gap-2 rounded-md border p-2.5 text-sm", off && "opacity-55")}>
            <SeverityIcon severity={i.severity} className="mt-0.5" />
            <div className="grid min-w-0 flex-1 gap-1">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge variant="outline">{QC_CATEGORY_LABELS[i.category] ?? i.category}</Badge>
                {i.shot != null && <Badge variant="outline">Shot {i.shot}</Badge>}
                {i.timestamp != null &&
                  (onSeek ? (
                    <button type="button" className="font-mono text-primary underline-offset-2 hover:underline" onClick={() => onSeek(i.timestamp!)}>
                      {formatSeconds(i.timestamp)}
                    </button>
                  ) : (
                    <span className="font-mono text-muted-foreground">{formatSeconds(i.timestamp)}</span>
                  ))}
                <span className="text-muted-foreground">{SOURCE_LABELS[i.source]}</span>
                {off && <span className="text-muted-foreground">· dismissed</span>}
              </div>
              <p className={cn(off && "line-through")}>{i.message}</p>
              {(i.expected || i.observed) && (
                <dl className="grid gap-0.5 text-xs text-muted-foreground">
                  {i.expected && (
                    <div>
                      <dt className="inline font-medium text-foreground/80">Expected: </dt>
                      <dd className="inline">{i.expected}</dd>
                    </div>
                  )}
                  {i.observed && (
                    <div>
                      <dt className="inline font-medium text-foreground/80">Seen: </dt>
                      <dd className="inline">{i.observed}</dd>
                    </div>
                  )}
                </dl>
              )}
              {i.fix && <p className="text-xs text-muted-foreground">Fix: {i.fix}</p>}
            </div>
            {sceneId && (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={pending}
                title={off ? "Restore this issue" : "Dismiss after checking it yourself"}
                aria-label={off ? "Restore issue" : "Dismiss issue"}
                onClick={() => run(() => dismissQcIssue(sceneId, i.id, !off))}
              >
                {off ? <RotateCcwIcon /> : <EyeOffIcon />}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function IssueCounts({ issues, dismissed = [] }: { issues: QcIssue[]; dismissed?: string[] }) {
  const skip = new Set(dismissed);
  const open = issues.filter((i) => !skip.has(i.id));
  const critical = open.filter((i) => i.severity === "critical").length;
  const warning = open.filter((i) => i.severity === "warning").length;
  if (!critical && !warning) return <span className="text-xs text-emerald-400">No open issues</span>;
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums">
      {critical > 0 && (
        <span className="inline-flex items-center gap-0.5 text-rose-300">
          <SeverityIcon severity="critical" className="size-3.5" />
          {critical} critical
        </span>
      )}
      {warning > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-300">
          <SeverityIcon severity="warning" className="size-3.5" />
          {warning} warning{warning === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}
