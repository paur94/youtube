"use client";

import { RefreshCwIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatUsd, type JobMode, type JobStatus } from "@/lib/production";
import { cancelJob, checkJob, retryJob } from "@/server/actions/production";

import { JobStatusBadge, ModeBadge } from "./badges";
import { useAction } from "./use-action";

export type JobItem = {
  id: string;
  mode: JobMode;
  status: JobStatus;
  modelLabel: string;
  outputKind: string;
  attempt: number;
  createdAt: string;
  estimatedCostUsd: string | null;
  error: string | null;
  externalRequestId: string | null;
  outputExpiresAt: string | null;
};

export function JobList({ jobs }: { jobs: JobItem[] }) {
  const [pending, run] = useAction();

  if (jobs.length === 0) {
    return <p className="text-sm text-muted-foreground">No generation attempts yet.</p>;
  }

  return (
    <ol className="grid gap-2">
      {jobs.map((job) => {
        const canCheck = job.mode === "api" && ["queued", "in_progress", "timed_out"].includes(job.status);
        const canRetry = job.mode === "api" && ["failed", "nsfw", "timed_out", "canceled"].includes(job.status);
        const canCancel =
          (job.mode === "api" && job.status === "queued" && job.externalRequestId) ||
          (job.mode === "manual" && job.status === "awaiting_manual");
        const usd = job.estimatedCostUsd === null ? null : Number(job.estimatedCostUsd);
        return (
          <li key={job.id} className="grid gap-1.5 rounded-lg border bg-background/40 p-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <ModeBadge mode={job.mode} />
              <JobStatusBadge status={job.status} />
              <span className="text-xs text-muted-foreground">
                {job.outputKind} · {job.modelLabel}
                {job.attempt > 1 && ` · attempt ${job.attempt}`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {job.createdAt}
              {job.mode === "api" &&
                (usd !== null && Number.isFinite(usd) ? ` · est. ${formatUsd(usd)}` : " · no price estimate")}
              {job.externalRequestId && ` · request ${job.externalRequestId.slice(0, 8)}`}
            </p>
            {job.error && <p className="text-xs text-rose-300">{job.error}</p>}
            {(canCheck || canRetry || canCancel) && (
              <div className="flex flex-wrap gap-1">
                {canCheck && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => checkJob(job.id))}>
                    <RefreshCwIcon />
                    {job.status === "timed_out" ? "Check again" : "Check now"}
                  </Button>
                )}
                {canRetry && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => retryJob(job.id))}>
                    <RotateCcwIcon />
                    Retry same request
                  </Button>
                )}
                {canCancel && (
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => cancelJob(job.id))}>
                    <XIcon />
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
