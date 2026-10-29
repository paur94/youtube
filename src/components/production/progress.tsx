import { SCENE_STATUS_LABELS, SCENE_STATUSES, type ProgressSummary, type SceneStatus } from "@/lib/production";
import { cn } from "@/lib/utils";

const SEGMENT_COLORS: Record<SceneStatus, string> = {
  approved: "bg-emerald-500",
  review: "bg-amber-400",
  generating: "bg-violet-400",
  failed: "bg-rose-500",
  ready: "bg-sky-500/60",
  draft: "bg-muted-foreground/30",
};

// Approved first so the bar reads as "done, then in flight, then to do".
const ORDER: SceneStatus[] = ["approved", "review", "generating", "failed", "ready", "draft"];

export function ProgressBar({ progress, className }: { progress: ProgressSummary; className?: string }) {
  return (
    <div
      className={cn("flex h-2 overflow-hidden rounded-full bg-muted", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.approved}
      aria-label={`${progress.approved} of ${progress.total} scenes approved`}
    >
      {progress.total > 0 &&
        ORDER.map((status) =>
          progress.counts[status] ? (
            <span
              key={status}
              className={SEGMENT_COLORS[status]}
              style={{ width: `${(progress.counts[status] / progress.total) * 100}%` }}
            />
          ) : null,
        )}
    </div>
  );
}

export function ProgressLegend({ progress }: { progress: ProgressSummary }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {SCENE_STATUSES.filter((s) => progress.counts[s] > 0).map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", SEGMENT_COLORS[status])} />
          {SCENE_STATUS_LABELS[status]} <span className="tabular-nums text-foreground">{progress.counts[status]}</span>
        </li>
      ))}
    </ul>
  );
}
