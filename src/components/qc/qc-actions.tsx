"use client";

import { ImagePlusIcon, RefreshCwIcon, ScanEyeIcon, ShieldCheckIcon, Undo2Icon, WandSparklesIcon } from "lucide-react";
import { useState } from "react";

import { AssetPreview } from "@/components/production/asset-preview";
import { AssetStatusBadge } from "@/components/production/badges";
import { useAction } from "@/components/production/use-action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { AssetStatus } from "@/lib/production";
import { cn } from "@/lib/utils";
import {
  applySceneCorrections,
  inspectAsset,
  inspectPlanClips,
  regenerateFailedClips,
  restoreScenePrompt,
  runStoryPreflight,
  setSceneReferences,
} from "@/server/actions/qc";

export function RunPreflightButton({ planId, current, disabled }: { planId: string; current: boolean; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button
      size="sm"
      variant={current ? "outline" : "default"}
      disabled={disabled || pending}
      title={current ? "Every scene was checked with its current script. Click to check again anyway." : "One Claude call for the whole story"}
      onClick={() => run(() => runStoryPreflight(planId, current))}
    >
      <ShieldCheckIcon />
      {pending ? "Checking story…" : current ? "Re-check story" : "Check story with Claude"}
    </Button>
  );
}

export function InspectPlanButton({ planId, disabled }: { planId: string; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || pending}
      title="Extracts frames from every uninspected clip and compares them with the story"
      onClick={() => run(() => inspectPlanClips(planId))}
    >
      <ScanEyeIcon />
      {pending ? "Inspecting clips…" : "Inspect clips"}
    </Button>
  );
}

export function RegenerateFailedButton({ planId, scenes, disabled }: { planId: string; scenes: number[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled || pending || !scenes.length} onClick={() => setOpen(true)}>
        <RefreshCwIcon />
        Regenerate failed ({scenes.length})
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate {scenes.length} scene{scenes.length === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Scene{scenes.length === 1 ? "" : "s"} {scenes.join(", ")} failed the vision check. Each prompt gets the continuity
              corrections, then one new clip per scene is submitted with the plan&apos;s video model. This is charged by the
              provider. The current final clips stay in place until a replacement passes inspection and your review.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(() => regenerateFailedClips(planId, true))}>Correct and regenerate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function InspectAssetButton({ assetId, inspected, disabled }: { assetId: string; inspected: boolean; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button
      size="sm"
      variant={inspected ? "ghost" : "outline"}
      disabled={disabled || pending}
      title="Compares frames of this file with the story, dialogue and reference images (one Claude call)"
      onClick={() => run(() => inspectAsset(assetId, inspected))}
    >
      <ScanEyeIcon />
      {pending ? "Inspecting…" : inspected ? "Inspect again" : "Inspect vs story"}
    </Button>
  );
}

export function CorrectionButtons({ sceneId, canRestore }: { sceneId: string; canRestore: boolean }) {
  const [pending, run] = useAction();
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        disabled={pending}
        title="Adds an explicit 'Continuity requirements' block to the visual prompt for every open issue"
        onClick={() => run(() => applySceneCorrections(sceneId))}
      >
        <WandSparklesIcon />
        Apply prompt corrections
      </Button>
      {canRestore && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => restoreScenePrompt(sceneId))}>
          <Undo2Icon />
          Restore previous prompt
        </Button>
      )}
    </div>
  );
}

export type ReferenceCandidate = {
  id: string;
  label: string;
  /** Section heading, e.g. "This scene", "Other scenes in this story", "Characters". */
  group: string;
  status: AssetStatus;
  filePath: string | null;
  sourceUrl: string | null;
};

/** Extra reference images for a scene (props, places, keyframes), sent alongside character references. */
export function SceneReferencePicker({
  sceneId,
  candidates,
  selected,
  maxReferenceImages,
}: {
  sceneId: string;
  candidates: ReferenceCandidate[];
  selected: string[];
  /** Largest reference-image limit among the models, to warn when the pick won't all be sent. */
  maxReferenceImages: number;
}) {
  // Rejected or deleted images drop out of the candidates; don't keep them selected.
  const available = selected.filter((id) => candidates.some((c) => c.id === id));
  const [picked, setPicked] = useState<string[]>(available);
  const [pending, run] = useAction();
  const dirty = picked.length !== selected.length || picked.some((id) => !selected.includes(id));
  if (!candidates.length) {
    return <p className="text-sm text-muted-foreground">Generate or import images in this story to use them as scene references.</p>;
  }
  const groups = [...new Set(candidates.map((c) => c.group))];
  return (
    <div className="grid gap-4">
      {groups.map((group) => (
        <section key={group} className="grid gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{group}</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {candidates
              .filter((c) => c.group === group)
              .map((c) => {
                const on = picked.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                    className={cn(
                      "grid content-start gap-1 rounded-md border p-1.5 text-left text-xs transition-colors",
                      on ? "border-primary bg-primary/10" : "hover:bg-muted/40",
                    )}
                  >
                    <AssetPreview kind="image" filePath={c.filePath} sourceUrl={c.sourceUrl} controls={false} />
                    <span className="line-clamp-2">{c.label}</span>
                    {c.status !== "approved" && <AssetStatusBadge status={c.status} />}
                  </button>
                );
              })}
          </div>
        </section>
      ))}
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || pending || picked.length > 8} onClick={() => run(() => setSceneReferences(sceneId, picked))}>
            <ImagePlusIcon />
            Save references ({picked.length})
          </Button>
          {picked.length > 8 && <p className="text-xs text-rose-300">Pick at most 8.</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Sent to reference-image models after the character references, in the order picked, and used by the vision check.
          {maxReferenceImages > 0 && ` Models take up to ${maxReferenceImages} images in total, so extras are dropped.`}
        </p>
      </div>
    </div>
  );
}

/** Approval blockers a reviewer may accept after checking them: Story QC criticals and Claude's children's-suitability concern. */
export function isAcceptableBlocker(blocker: string) {
  return blocker.startsWith("Story consistency:") || blocker.startsWith("Children's suitability:");
}

/** Lets a reviewer accept those quality-control issues as OK, so they stop blocking review. */
export function AcceptQcCheckbox({ checked, onChange, disabled }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-primary"
      />
      I checked the story consistency and children&apos;s suitability issues above and they are OK for us. Accept them and continue.
    </label>
  );
}
