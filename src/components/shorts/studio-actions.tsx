"use client";

import { ImportIcon, ListOrderedIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { analyzeShort, importShorts, suggestPublishOrder } from "@/server/actions/shorts";

type Candidate = { id: string; title: string; scenes: { sceneId: string; position: number; title: string; durationSeconds: string | null; shortId: string | null }[] };

export function ImportShortsButton({ plans }: { plans: Candidate[] }) {
  const available = plans.flatMap((p) => p.scenes.filter((s) => !s.shortId).map((s) => s.sceneId));
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(available));
  const [pending, run] = useAction();

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <>
      <Button
        onClick={() => {
          setSelected(new Set(available));
          setOpen(true);
        }}
        disabled={available.length === 0}
        title={available.length ? undefined : "Every approved scene video is already a Short, or none is approved yet"}
      >
        <ImportIcon />
        Import scenes
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import scene videos as Shorts</DialogTitle>
            <DialogDescription>
              One Short per scene, from each scene&apos;s approved final video in the Production Studio. The original clips are
              never changed: the vertical version is rendered as a new file.
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-96 gap-4 overflow-y-auto">
            {plans.map((plan) => (
              <div key={plan.id} className="grid gap-1.5">
                <p className="text-sm font-medium">{plan.title}</p>
                {plan.scenes.map((s) => (
                  <label key={s.sceneId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={Boolean(s.shortId)}
                      checked={!s.shortId && selected.has(s.sceneId)}
                      onChange={(e) => toggle(s.sceneId, e.target.checked)}
                      className="size-3.5 accent-primary"
                    />
                    <span className="text-muted-foreground tabular-nums">{s.position + 1}.</span>
                    <span className={s.shortId ? "text-muted-foreground" : undefined}>{s.title}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {s.shortId ? "already a Short" : s.durationSeconds ? `${Number(s.durationSeconds)}s` : ""}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || selected.size === 0} onClick={() => run(() => importShorts([...selected]), () => setOpen(false))}>
              {pending ? "Importing…" : `Create ${selected.size} Short${selected.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Runs the per-Short analysis one at a time so each result is saved as soon as it arrives. */
export function AnalyzeAllButton({ ids, disabled }: { ids: string[]; disabled?: boolean }) {
  const [progress, setProgress] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function runAll() {
    let failed = 0;
    for (const [i, id] of ids.entries()) {
      setProgress(i);
      try {
        const result = await analyzeShort(id);
        if (!result.ok) {
          failed++;
          toast.error(result.message);
          if (/not configured|rejected|rate limit/i.test(result.message)) break;
        }
      } catch {
        failed++;
      }
    }
    setProgress(null);
    startTransition(() => router.refresh());
    if (failed) toast.error(`${failed} analysis call${failed === 1 ? "" : "s"} failed`);
    else toast.success(`Analysed ${ids.length} Short${ids.length === 1 ? "" : "s"}`);
  }

  return (
    <Button variant="outline" disabled={disabled || progress !== null || ids.length === 0} onClick={() => void runAll()}>
      <SparklesIcon />
      {progress !== null ? `Analysing ${progress + 1}/${ids.length}…` : `Analyse ${ids.length} with Claude`}
    </Button>
  );
}

export function SuggestOrderButton({ planId, disabled }: { planId: string; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button variant="outline" size="sm" disabled={disabled || pending} onClick={() => run(() => suggestPublishOrder(planId))}>
      <ListOrderedIcon />
      {pending ? "Thinking…" : "Suggest publishing order"}
    </Button>
  );
}
