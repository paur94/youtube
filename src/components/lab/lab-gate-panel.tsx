"use client";

import { BadgeCheckIcon, ImageIcon, Loader2Icon, ScanEyeIcon, ScanSearchIcon, ShieldCheckIcon, Undo2Icon, WandSparklesIcon } from "lucide-react";

import { GateCounts, GateReport } from "@/components/qc/gate-report";
import { SeverityIcon } from "@/components/qc/qc-issue-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { GateEvaluation } from "@/lib/generation-qc";
import { GATE_GROUP_LABELS } from "@/lib/generation-qc";
import { klingPromptLimit } from "@/lib/lab";
import { type LabClipReport, labClipStatus, readLabClipReport } from "@/lib/lab-qc";
import { formatSeconds } from "@/lib/story-qc";
import type { ActionResult } from "@/server/actions/ideas";
import { acceptLabIssues, approveLabScene, dismissLabCheck, generateLabVideo, inspectLabClip, reviewLabScene } from "@/server/actions/lab";

type Steps = {
  pending: boolean;
  label: string | null;
  run: (name: string, ...steps: (() => Promise<ActionResult | null>)[]) => void;
};

/**
 * Pre-generation QC for one lab scene. Evaluated on the editor's current text, so rule findings update
 * while typing; the review and approval apply to the saved version (both buttons save first).
 */
export function LabGatePanel({
  projectId,
  sceneId,
  evaluation,
  clipSeconds,
  aiConfigured,
  storyApproved,
  steps,
  save,
  finalPrompt,
  onApplyPrompt,
  onApplyImagePrompt,
}: {
  projectId: string;
  sceneId: string;
  evaluation: GateEvaluation;
  clipSeconds: number;
  aiConfigured: boolean;
  storyApproved: boolean;
  steps: Steps;
  save: () => Promise<ActionResult | null>;
  /** Puts a corrected motion prompt into the editor (not saved until the person saves or reviews). */
  onApplyPrompt: (prompt: string) => void;
  /** The exact text Kling will get for the editor's current version (motion prompt, frame notes, cast, dialogue). */
  finalPrompt: string;
  /** Puts a corrected image prompt into the editor, to generate a new start frame from. */
  onApplyImagePrompt: (prompt: string) => void;
}) {
  const review = evaluation.review;
  const busy = steps.pending;
  const label = (name: string) => steps.label === `${name}:${sceneId}`;
  // Only soft critical issues (AI or rule findings a person can judge) can be accepted; hard ones still block.
  const acceptable = !evaluation.approved && evaluation.critical.length > 0 && evaluation.critical.every((c) => !c.hard);

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
        The clip can only be generated once this exact version (motion prompt, dialogue, length, start frame, cast and references) has
        no open critical issues and you approve it. Any edit needs a new review. If you checked a critical issue and it's fine, mark it OK
        (or mark them all OK and generate).
      </p>
      <div className="flex flex-wrap gap-2">
        {aiConfigured && (
          <Button
            size="sm"
            variant={evaluation.reviewCurrent ? "outline" : "default"}
            disabled={busy}
            title="Saves, then one OpenAI call checks the frames, actions, timeline and continuity of this request"
            onClick={() => steps.run(`review:${sceneId}`, save, () => reviewLabScene(projectId, sceneId))}
          >
            {label("review") ? <Loader2Icon className="animate-spin" /> : <ScanSearchIcon />}
            {evaluation.reviewCurrent ? "Review again" : "Save and run AI review"}
          </Button>
        )}
        {review?.suggestedPrompt && (
          <Button size="sm" variant="outline" disabled={busy} title="Replaces the motion prompt in the editor; review it again afterwards" onClick={() => onApplyPrompt(review.suggestedPrompt)}>
            <WandSparklesIcon /> Use suggested prompt
          </Button>
        )}
        {review?.suggestedImagePrompt && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="The start frame can't begin this action. Replaces the image prompt in the editor; generate a new image, pick it as start frame and review again"
            onClick={() => onApplyImagePrompt(review.suggestedImagePrompt!)}
          >
            <ImageIcon /> Use corrected image prompt
          </Button>
        )}
        {evaluation.approved ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => steps.run(`approve:${sceneId}`, () => approveLabScene(projectId, sceneId, false))}>
            <Undo2Icon /> Withdraw approval
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || !evaluation.canApprove || !storyApproved}
            title={!storyApproved ? "Approve the story first" : evaluation.canApprove ? "I reviewed the report and want to generate this version" : "Resolve the critical issues first"}
            onClick={() => steps.run(`approve:${sceneId}`, save, () => approveLabScene(projectId, sceneId, true))}
          >
            {label("approve") ? <Loader2Icon className="animate-spin" /> : <BadgeCheckIcon />} Approve this version
          </Button>
        )}
        {acceptable && (
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !storyApproved}
            title={
              !storyApproved
                ? "Approve the story first"
                : `I checked the ${evaluation.critical.length} critical issue${evaluation.critical.length === 1 ? "" : "s"} and they are OK: mark them OK, approve this version and generate the clip (paid)`
            }
            onClick={() => {
              const n = evaluation.critical.length;
              if (!window.confirm(`Mark ${n} critical issue${n === 1 ? "" : "s"} as OK and generate the clip now? This starts a paid Kling run.`)) return;
              steps.run(`accept:${sceneId}`, save, () => acceptLabIssues(projectId, sceneId), () => generateLabVideo(projectId, sceneId));
            }}
          >
            {label("accept") ? <Loader2Icon className="animate-spin" /> : <BadgeCheckIcon />} Mark issues OK and generate
          </Button>
        )}
      </div>

      <GateReport
        evaluation={evaluation}
        clipSeconds={clipSeconds}
        pending={busy}
        onDismiss={(id, dismissed) => steps.run("dismiss", () => dismissLabCheck(projectId, sceneId, id, dismissed))}
      />

      {review?.suggestedPrompt && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Suggested motion prompt</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md border bg-background/60 p-2.5 whitespace-pre-wrap">{review.suggestedPrompt}</pre>
        </details>
      )}
      {review?.suggestedImagePrompt && (
        <details className="text-xs">
          <summary className="cursor-pointer text-amber-300">Corrected image prompt (generate a new start frame first)</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-md border bg-background/60 p-2.5 whitespace-pre-wrap">{review.suggestedImagePrompt}</pre>
        </details>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Final prompt sent to Kling ({finalPrompt.length.toLocaleString("en-US")} of {klingPromptLimit(finalPrompt).toLocaleString("en-US")} characters)
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border bg-background/60 p-2.5 whitespace-pre-wrap">{finalPrompt}</pre>
      </details>
    </section>
  );
}

const STATUS: Record<ReturnType<typeof labClipStatus>, { label: string; className: string }> = {
  none: { label: "Not inspected", className: "text-muted-foreground" },
  stale: { label: "Inspected before later edits", className: "text-muted-foreground" },
  pass: { label: "Matches the request", className: "text-emerald-300" },
  warn: { label: "Minor issues", className: "text-amber-300" },
  fail: { label: "Critical mistakes", className: "text-rose-300" },
};

/** Post-generation inspection of a finished lab clip, with timestamps that seek the player above. */
export function LabClipInspection({
  job,
  contentKey,
  aiConfigured,
  steps,
  onApplyPrompt,
}: {
  job: { id: string; qc: unknown };
  contentKey: string;
  aiConfigured: boolean;
  steps: Steps;
  onApplyPrompt: (prompt: string) => void;
}) {
  const report: LabClipReport | null = readLabClipReport(job.qc);
  const status = labClipStatus(report, contentKey);
  const seek = (t: number) => {
    const video = document.getElementById(`lab-video-${job.id}`) as HTMLVideoElement | null;
    if (!video) return;
    video.currentTime = t;
    video.pause();
  };
  return (
    <div className="grid gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className={STATUS[status].className}>{STATUS[status].label}</span>
        {aiConfigured && (
          <Button
            size="xs"
            variant={report ? "ghost" : "secondary"}
            className="ml-auto"
            disabled={steps.pending}
            title="Extracts frames across the clip and compares them with the prompt, timeline and references (one OpenAI call)"
            onClick={() => steps.run(`inspect:${job.id}`, () => inspectLabClip(job.id))}
          >
            {steps.label === `inspect:${job.id}` ? <Loader2Icon className="animate-spin" /> : <ScanEyeIcon />} {report ? "Inspect again" : "Inspect"}
          </Button>
        )}
      </div>
      {report && (
        <>
          {report.summary && <p className="text-muted-foreground">{report.summary}</p>}
          {report.issues.length > 0 && (
            <ul className="grid gap-1">
              {report.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1.5 rounded border p-1.5">
                  <SeverityIcon severity={issue.severity} className="mt-0.5 size-3.5" />
                  <div className="grid min-w-0 gap-0.5">
                    <p>
                      {issue.timestamp != null && (
                        <button type="button" className="mr-1 font-mono text-primary hover:underline" onClick={() => seek(issue.timestamp!)}>
                          {formatSeconds(issue.timestamp)}
                        </button>
                      )}
                      <span className="font-medium">{issue.label}</span>
                      <span className="ml-1 text-muted-foreground">· {GATE_GROUP_LABELS[issue.group]}</span>
                    </p>
                    {issue.expected && <p className="text-muted-foreground">Expected: {issue.expected}</p>}
                    {issue.observed && <p className="text-muted-foreground">Seen: {issue.observed}</p>}
                    {issue.fix && <p>Fix: {issue.fix}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {report.suggestedPrompt && (
            <div>
              <Button size="xs" variant="outline" disabled={steps.pending} onClick={() => onApplyPrompt(report.suggestedPrompt)}>
                <WandSparklesIcon /> Use corrected prompt for the next attempt
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
