import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { CheckStatus } from "@/lib/short-qc";
import { SHORT_STATUS_LABELS, type ShortAnalysis, type ShortStatus, STANDALONE_LABELS } from "@/lib/shorts";
import { cn } from "@/lib/utils";

const MUTED = "bg-muted text-muted-foreground";
const AMBER = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
const SKY = "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300";
const VIOLET = "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300";
const GREEN = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const RED = "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300";

const STATUS_STYLES: Record<ShortStatus, string> = {
  draft: MUTED,
  approved: SKY,
  rejected: RED,
  scheduled: VIOLET,
  published: GREEN,
};

export function ShortStatusBadge({ status }: { status: ShortStatus }) {
  return <Badge className={cn(STATUS_STYLES[status])}>{SHORT_STATUS_LABELS[status]}</Badge>;
}

const STANDALONE_STYLES: Record<ShortAnalysis["standalone"]["verdict"], string> = { strong: GREEN, usable: SKY, weak: AMBER };

export function StandaloneBadge({ verdict }: { verdict: ShortAnalysis["standalone"]["verdict"] }) {
  return (
    <Badge variant="outline" className={cn("border-transparent", STANDALONE_STYLES[verdict])}>
      {verdict === "weak" && <TriangleAlertIcon />}
      {STANDALONE_LABELS[verdict]}
    </Badge>
  );
}

export function CheckIcon({ status, className }: { status: CheckStatus; className?: string }) {
  const props = { className: cn("size-4 shrink-0", className) };
  switch (status) {
    case "pass":
      return <CircleCheckIcon {...props} className={cn(props.className, "text-emerald-400")} aria-label="Pass" />;
    case "warn":
      return <TriangleAlertIcon {...props} className={cn(props.className, "text-amber-400")} aria-label="Warning" />;
    case "fail":
      return <CircleXIcon {...props} className={cn(props.className, "text-rose-400")} aria-label="Fail" />;
    default:
      return <CircleDashedIcon {...props} className={cn(props.className, "text-muted-foreground")} aria-label="Not available" />;
  }
}

export function QualitySummary({ summary }: { summary: { pass: number; warn: number; fail: number; unavailable: number } }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
      <span className="inline-flex items-center gap-0.5" title="Passed">
        <CheckIcon status="pass" className="size-3.5" />
        {summary.pass}
      </span>
      <span className="inline-flex items-center gap-0.5" title="Warnings">
        <CheckIcon status="warn" className="size-3.5" />
        {summary.warn}
      </span>
      <span className="inline-flex items-center gap-0.5" title="Failed">
        <CheckIcon status="fail" className="size-3.5" />
        {summary.fail}
      </span>
      {summary.unavailable > 0 && (
        <span className="inline-flex items-center gap-0.5" title="Not checked yet">
          <CheckIcon status="unavailable" className="size-3.5" />
          {summary.unavailable}
        </span>
      )}
    </span>
  );
}
