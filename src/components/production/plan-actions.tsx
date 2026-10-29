"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  ClapperboardIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HIGGSFIELD_MODELS } from "@/lib/higgsfield";
import { ASPECT_RATIOS, type PlanStatus } from "@/lib/production";
import {
  addScene,
  createProductionPlan,
  deleteProductionPlan,
  deleteScene,
  moveScene,
  refreshJobs,
  setPlanReady,
  updatePlanSettings,
} from "@/server/actions/production";

import { useAction } from "./use-action";

type StoryChoice = { id: string; title: string; sceneCount: number };

export function NewPlanButton({ stories }: { stories: StoryChoice[] }) {
  const [open, setOpen] = useState(false);
  const [storyId, setStoryId] = useState(stories[0]?.id ?? "");
  const [pending, run] = useAction();
  const id = useId();

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={stories.length === 0} title={stories.length ? undefined : "Approve a story in the Story Workshop first"}>
        <PlusIcon />
        New production plan
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start production</DialogTitle>
            <DialogDescription>
              Imports the approved story&apos;s scenes, narration, dialogue, characters and visual prompts. The story
              itself isn&apos;t changed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-story`}>Approved story</Label>
            <Select value={storyId} onValueChange={setStoryId}>
              <SelectTrigger id={`${id}-story`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stories.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.title} · {s.sceneCount} scenes
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!storyId || pending} onClick={() => run(() => createProductionPlan(storyId))}>
              <ClapperboardIcon />
              {pending ? "Importing…" : "Create plan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeletePlanButton({ planId, title }: { planId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  const router = useRouter();
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Delete plan" onClick={() => setOpen(true)} disabled={pending}>
        <Trash2Icon />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the plan, its scenes, generation history and asset records. The story stays in the Story
              Workshop, characters stay in the library, and files stay in the media folder on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => deleteProductionPlan(planId), () => router.push("/production"))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AddSceneButton({ planId }: { planId: string }) {
  const [pending, run] = useAction();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => addScene(planId))}>
      <PlusIcon />
      Add scene
    </Button>
  );
}

export function SceneOrderButtons({ sceneId, first, last }: { sceneId: string; first: boolean; last: boolean }) {
  const [pending, run] = useAction();
  return (
    <div className="relative z-10 flex flex-col">
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Move scene up"
        disabled={first || pending}
        onClick={() => run(() => moveScene(sceneId, "up"))}
      >
        <ArrowUpIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Move scene down"
        disabled={last || pending}
        onClick={() => run(() => moveScene(sceneId, "down"))}
      >
        <ArrowDownIcon />
      </Button>
    </div>
  );
}

export function DeleteSceneButton({ sceneId, planId, title }: { sceneId: string; planId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  const router = useRouter();
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} disabled={pending}>
        <Trash2Icon />
        Delete scene
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the scene with its generation history and asset records. Files stay on disk. Later scenes are
              renumbered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => deleteScene(sceneId), () => router.push(`/production/${planId}`))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function PlanSettings({
  planId,
  settings,
}: {
  planId: string;
  settings: { aspectRatio: string; imageModel: string; videoModel: string; visualStyle: string };
}) {
  const [values, setValues] = useState(settings);
  const [pending, run] = useAction();
  const id = useId();
  const dirty = JSON.stringify(values) !== JSON.stringify(settings);

  const select = (key: "aspectRatio" | "imageModel" | "videoModel", label: string, options: [string, string][]) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Select value={values[key]} onValueChange={(v) => setValues({ ...values, [key]: v })}>
        <SelectTrigger id={`${id}-${key}`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([value, text]) => (
            <SelectItem key={value} value={value}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="grid gap-3">
      {select("aspectRatio", "Aspect ratio", ASPECT_RATIOS.map((r) => [r, r]))}
      {select(
        "imageModel",
        "Default image model",
        HIGGSFIELD_MODELS.filter((m) => m.output === "image").map((m) => [m.id, m.label]),
      )}
      {select(
        "videoModel",
        "Default video model",
        HIGGSFIELD_MODELS.filter((m) => m.output === "video").map((m) => [m.id, m.label]),
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-style`}>Visual style</Label>
        <Input
          id={`${id}-style`}
          value={values.visualStyle}
          maxLength={300}
          onChange={(e) => setValues({ ...values, visualStyle: e.target.value })}
          placeholder="e.g. Soft 3D animation, pastel colours"
        />
        <p className="text-xs text-muted-foreground">Added to prompts that don&apos;t already mention it.</p>
      </div>
      <Button variant="outline" disabled={!dirty || pending} onClick={() => run(() => updatePlanSettings(planId, values))}>
        Save settings
      </Button>
    </div>
  );
}

export function AssemblyPanel({ planId, status, ready }: { planId: string; status: PlanStatus; ready: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, run] = useAction();

  if (status === "ready_for_assembly") {
    return (
      <div className="grid gap-3">
        <p className="flex items-start gap-2 text-sm">
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          Every scene has a reviewed, approved final asset. Assembly and publishing are separate, manual steps.
        </p>
        <Button variant="outline" disabled={pending} onClick={() => run(() => setPlanReady(planId, false))}>
          Move back to production
        </Button>
      </div>
    );
  }
  if (!ready) {
    return (
      <p className="text-sm text-muted-foreground">
        Final assembly unlocks once every scene has an approved final asset. Review each generated image or clip on its
        scene page.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
        />
        I have watched every final asset and checked it for safety, age-appropriateness and originality.
      </label>
      <Button disabled={!confirmed || pending} onClick={() => run(() => setPlanReady(planId, true))}>
        <CheckCircle2Icon />
        Mark ready for assembly
      </Button>
      <p className="text-xs text-muted-foreground">Nothing is rendered, uploaded or published.</p>
    </div>
  );
}

/**
 * While API jobs are queued or running, asks the server to poll Higgsfield and refreshes the page
 * when something changed. Slows down when nothing changes; stops when no job is active.
 */
export function JobPoller({ planId, sceneId, active }: { planId?: string; sceneId?: string; active: number }) {
  const router = useRouter();
  const delay = useRef(5000);
  const warned = useRef(false);

  const poll = useEffectEvent(async () => {
    const result = await refreshJobs({ planId, sceneId });
    if (result.message && !warned.current) {
      warned.current = true;
      toast.error(result.message);
    }
    if (result.changed) {
      delay.current = 5000;
      router.refresh();
    } else {
      delay.current = Math.min(delay.current * 1.5, 30_000);
    }
    return result.active;
  });

  useEffect(() => {
    if (active === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      let remaining = 1;
      try {
        remaining = await poll();
      } catch {
        delay.current = 30_000;
      }
      if (!stopped && remaining > 0) timer = setTimeout(tick, delay.current);
    };
    timer = setTimeout(tick, delay.current);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active]);

  if (active === 0) return null;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <span className="size-2 animate-pulse rounded-full bg-violet-400" />
      {active} Higgsfield {active === 1 ? "job" : "jobs"} running. Checking status automatically.
    </p>
  );
}
