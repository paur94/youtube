"use client";

import { BadgeCheckIcon, ScanSearchIcon, ShieldCheckIcon, Undo2Icon, WandSparklesIcon } from "lucide-react";

import { CopyButton } from "@/components/production/copy-button";
import { useAction } from "@/components/production/use-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GateEvaluation } from "@/lib/generation-qc";
import { applySceneCorrections, approveSceneGeneration, dismissQcIssue, reviewSceneGeneration } from "@/server/actions/qc";

import { GateCounts, GateReport } from "./gate-report";

/**
 * Pre-generation QC for a Kids Studio clip: rule checks, the Claude frame review, corrections and the
 * approval that unlocks "Generate". Everything is for the model and start image picked above.
 */
export function KidsGatePanel({
  sceneId,
  modelId,
  startAssetId,
  evaluation,
  clipSeconds,
  aiConfigured,
  blockedReason,
}: {
  sceneId: string;
  modelId: string;
  startAssetId: string | null;
  evaluation: GateEvaluation;
  clipSeconds: number;
  aiConfigured: boolean;
  /** Set while the picks above aren't saved or complete, so a review would check the wrong version. */
  blockedReason: string | null;
}) {
  const [pending, run] = useAction();
  const review = evaluation.review;
  const request = { modelId, startAssetId };
  const hasFixes = Boolean(review && (review.promptAdditions || review.checks.some((c) => c.status !== "passed" && c.fix)));

  return (
    <section className="grid gap-3 rounded-lg border border-sky-500/30 p-3">
      <header className="flex flex-wrap items-center gap-2">
        <ShieldCheckIcon className="size-4 text-sky-400" />
        <h4 className="text-sm font-medium">Pre-generation QC</h4>
        {evaluation.approved ? (
          <Badge className="gap-1">
            <BadgeCheckIcon className="size-3" /> Approved
          </Badge>
        ) : (
          <Badge variant="secondary">Not approved</Badge>
        )}
        <span className="ml-auto">
          <GateCounts evaluation={evaluation} />
        </span>
      </header>
      <p className="text-xs text-muted-foreground">
        Nothing is generated until this exact version (prompt, frames, references, model and length) has no open critical issues and
        you approve it. Any edit needs a new review.
        {aiConfigured ? " The AI review is one Claude call that looks at the start, middle and end frames and the references." : ""}
      </p>

      <div className="flex flex-wrap gap-2">
        {aiConfigured && (
          <Button
            size="sm"
            variant={evaluation.reviewCurrent ? "outline" : "default"}
            disabled={pending || Boolean(blockedReason)}
            title={blockedReason ?? "Checks the frames, actions, timeline and continuity of this exact request"}
            onClick={() => run(() => reviewSceneGeneration(sceneId, request))}
          >
            <ScanSearchIcon />
            {pending ? "Working…" : evaluation.reviewCurrent ? "Review again" : "Run AI review"}
          </Button>
        )}
        {hasFixes && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            title="Appends the review's requirements to the visual prompt (kept in the prompt history); the version then needs a new review"
            onClick={() => run(() => applySceneCorrections(sceneId))}
          >
            <WandSparklesIcon />
            Apply fixes to prompt
          </Button>
        )}
        {evaluation.approved ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => approveSceneGeneration(sceneId, request, false))}>
            <Undo2Icon />
            Withdraw approval
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={pending || !evaluation.canApprove || Boolean(blockedReason)}
            title={evaluation.canApprove ? "I reviewed the report and want to generate this version" : "Resolve the critical issues first"}
            onClick={() => run(() => approveSceneGeneration(sceneId, request, true))}
          >
            <BadgeCheckIcon />
            Approve this version
          </Button>
        )}
      </div>
      {blockedReason && <p className="text-xs text-amber-300">{blockedReason}</p>}

      <GateReport
        evaluation={evaluation}
        clipSeconds={clipSeconds}
        pending={pending}
        onDismiss={(id, dismissed) => run(() => dismissQcIssue(sceneId, id, dismissed))}
      />

      {review?.suggestedPrompt && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Suggested action, re-timed for the {clipSeconds}s clip</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md border bg-background/60 p-2.5 whitespace-pre-wrap">{review.suggestedPrompt}</pre>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <CopyButton text={review.suggestedPrompt} label="Copy suggested action" />
            <span className="text-muted-foreground">Paste it into the scene&apos;s Action field if you agree, then review again.</span>
          </div>
        </details>
      )}
    </section>
  );
}
