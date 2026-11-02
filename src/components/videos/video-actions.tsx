"use client";

import { CheckCircle2Icon, MonitorPlayIcon, RotateCcwIcon, SendIcon, SparklesIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form-fields";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { VideoMetadataState, VideoStatus } from "@/lib/long-video";
import { findMetadataConcerns, normalizeHashtags, TITLE_MAX } from "@/lib/shorts";
import {
  approveVideo,
  createVideo,
  deleteVideo,
  rejectVideo,
  reopenVideo,
  setVideoMetadataApproval,
  submitVideoForReview,
  suggestVideoMetadata,
  updateVideoMetadata,
} from "@/server/actions/videos";

type PlanClips = { id: string; title: string; scenes: { sceneId: string; position: number; title: string; durationSeconds: string | null }[] };

/** Picks a plan and its scenes, then opens the new video. */
export function NewVideoButton({ plans, planId, label = "New video" }: { plans: PlanClips[]; planId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(planId ?? plans[0]?.id ?? "");
  const plan = plans.find((p) => p.id === selectedPlan);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startCreate] = useTransition();
  const router = useRouter();

  function choosePlan(id: string) {
    setSelectedPlan(id);
    setSelected(new Set(plans.find((p) => p.id === id)?.scenes.map((s) => s.sceneId)));
  }

  function create() {
    startCreate(async () => {
      try {
        const result = await createVideo(selectedPlan, [...selected]);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        toast.success(result.message);
        setOpen(false);
        if (result.id) router.push(`/videos/${result.id}`);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <>
      <Button
        onClick={() => {
          choosePlan(planId ?? selectedPlan);
          setOpen(true);
        }}
        disabled={plans.length === 0}
        title={plans.length ? undefined : "No production plan has an approved scene video yet"}
      >
        <MonitorPlayIcon />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Combine scenes into one 16:9 video</DialogTitle>
            <DialogDescription>
              Uses each scene&apos;s approved final clip, in scene order. You can reorder, trim and remove clips afterwards. The
              original clips are never changed.
            </DialogDescription>
          </DialogHeader>
          {!planId && plans.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {plans.map((p) => (
                <Button key={p.id} size="sm" variant={p.id === selectedPlan ? "default" : "outline"} onClick={() => choosePlan(p.id)}>
                  {p.title}
                </Button>
              ))}
            </div>
          )}
          <div className="grid max-h-80 gap-1.5 overflow-y-auto">
            {plan?.scenes.map((s) => (
              <label key={s.sceneId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(s.sceneId)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.sceneId);
                      else next.delete(s.sceneId);
                      return next;
                    })
                  }
                  className="size-3.5 accent-primary"
                />
                <span className="text-muted-foreground tabular-nums">{s.position + 1}.</span>
                <span>{s.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">{s.durationSeconds ? `${Number(s.durationSeconds)}s` : ""}</span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || selected.size === 0} onClick={create}>
              {pending ? "Creating…" : `Combine ${selected.size} scene${selected.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Removes a video from the studio after confirmation. */
export function RemoveVideoButton({
  videoId,
  title,
  published,
  redirect,
  compact,
}: {
  videoId: string;
  title: string;
  published: boolean;
  /** Where to go afterwards (from the video's own page). */
  redirect?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  const router = useRouter();
  return (
    <>
      <Button
        variant="ghost"
        size={compact ? "icon" : "sm"}
        className={compact ? "text-muted-foreground hover:text-destructive" : "w-fit text-muted-foreground"}
        disabled={pending}
        onClick={() => setOpen(true)}
        aria-label={`Remove “${title}”`}
        title="Remove from the studio"
      >
        <Trash2Icon />
        {!compact && "Remove video"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the video, its edit and its rendered files from the studio. The production scenes and their clips stay untouched.
              {published && " It stays on YouTube: delete it in YouTube Studio if you want it gone there too."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run(() => deleteVideo(videoId), () => (redirect ? router.push(redirect) : undefined))}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export type VideoMetadataValues = { title: string; description: string; hashtags: string[]; playlist: string; notes: string };

export function VideoMetadataForm({
  videoId,
  values,
  locked,
  approved,
  formKey,
  chapters,
}: {
  videoId: string;
  values: VideoMetadataValues;
  locked: boolean;
  approved: boolean;
  formKey: string;
  /** Chapter list appended to the description on upload, or null. */
  chapters: string | null;
}) {
  const [state, formAction, pending] = useActionState<VideoMetadataState, FormData>(updateVideoMetadata.bind(null, videoId), null);
  const [title, setTitle] = useState(values.title);
  const [description, setDescription] = useState(values.description);
  const [hashtags, setHashtags] = useState(values.hashtags.join(" "));
  // Server-side changes (e.g. Claude's suggestions) bump formKey; resync the controlled fields.
  const [syncedKey, setSyncedKey] = useState(formKey);
  if (syncedKey !== formKey) {
    setSyncedKey(formKey);
    setTitle(values.title);
    setDescription(values.description);
    setHashtags(values.hashtags.join(" "));
  }
  const [approving, runApproval] = useAction();
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;
  const concerns = findMetadataConcerns({ title, description, hashtags: normalizeHashtags(hashtags), hook: "" });

  const onResult = useEffectEvent((result: NonNullable<VideoMetadataState>) => {
    if (result.ok) toast.success(result.message);
    else if (result.message) toast.error(result.message);
  });
  useEffect(() => {
    if (state) onResult(state);
  }, [state]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4" key={formKey}>
      <fieldset disabled={locked} className="grid gap-4">
        <Field id={`${id}-title`} label="Title" hint={`${title.length}/${TITLE_MAX}`} error={errors?.title}>
          <Input id={`${id}-title`} name="title" required maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id={`${id}-description`} label="Description" hint="for parents" error={errors?.description}>
          <Textarea id={`${id}-description`} name="description" rows={5} maxLength={4400} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {chapters && (
          <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">Chapters added below the description on upload:</p>
            <pre className="rounded-md border bg-muted/40 p-2 font-sans text-xs whitespace-pre-wrap">{chapters}</pre>
          </div>
        )}
        <Field id={`${id}-hashtags`} label="Hashtags" hint="space or comma separated" error={errors?.hashtags}>
          <Input id={`${id}-hashtags`} name="hashtags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </Field>
        <Field id={`${id}-playlist`} label="Suggested playlist" error={errors?.playlist}>
          <Input id={`${id}-playlist`} name="playlist" maxLength={150} defaultValue={values.playlist} />
        </Field>
        <Field id={`${id}-notes`} label="Notes" error={errors?.notes}>
          <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={4000} defaultValue={values.notes} />
        </Field>
      </fieldset>
      {concerns.map((c) => (
        <p key={c} className="text-xs text-destructive">
          {c}
        </p>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {approved ? (
          <Button type="button" variant="ghost" disabled={locked || approving} onClick={() => runApproval(() => setVideoMetadataApproval(videoId, false))}>
            Remove approval
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={locked || approving || concerns.length > 0}
            title="Approves the saved metadata. Save your edits first."
            onClick={() => runApproval(() => setVideoMetadataApproval(videoId, true))}
          >
            <CheckCircle2Icon />
            Approve metadata
          </Button>
        )}
        <Button type="submit" disabled={locked || pending}>
          {pending ? "Saving…" : "Save metadata"}
        </Button>
      </div>
    </form>
  );
}

export function SuggestMetadataButton({ videoId, disabled }: { videoId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled || pending} onClick={() => setOpen(true)}>
        <SparklesIcon />
        {pending ? "Writing… (up to a minute)" : "Suggest with Claude"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the metadata with Claude&apos;s suggestions?</AlertDialogTitle>
            <AlertDialogDescription>
              Claude writes a title, description, hashtags and playlist from the story and scenes. Your current text is replaced and the
              metadata needs approving again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(() => suggestVideoMetadata(videoId))}>Suggest</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function VideoReviewActions({
  videoId,
  status,
  uploaded,
  blockers,
  title,
}: {
  videoId: string;
  status: VideoStatus;
  uploaded: boolean;
  blockers: string[];
  title: string;
}) {
  const [pending, run] = useAction();
  const [confirmed, setConfirmed] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const blockerList = blockers.length > 0 && (
    <ul className="grid gap-1 text-xs text-muted-foreground">
      {blockers.map((b) => (
        <li key={b}>· {b}</li>
      ))}
    </ul>
  );

  return (
    <div className="grid gap-3">
      {status === "draft" && (
        <>
          {blockerList}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || blockers.length > 0} onClick={() => run(() => submitVideoForReview(videoId))}>
              <SendIcon />
              Submit for review
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setRejectOpen(true)}>
              <XCircleIcon />
              Reject
            </Button>
          </div>
        </>
      )}
      {status === "ready_for_review" && (
        <>
          {blockerList || (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
              />
              I watched the whole rendered 16:9 video with sound, and it is suitable for children.
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || blockers.length > 0 || !confirmed} onClick={() => run(() => approveVideo(videoId, confirmed))}>
              <CheckCircle2Icon />
              Approve video
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setRejectOpen(true)}>
              <XCircleIcon />
              Reject
            </Button>
          </div>
        </>
      )}
      {status !== "draft" && status !== "published" && !uploaded && (
        <Button variant="outline" className="w-fit" disabled={pending} onClick={() => run(() => reopenVideo(videoId))}>
          <RotateCcwIcon />
          Back to draft
        </Button>
      )}
      {(status === "published" || uploaded) && (
        <p className="text-sm text-muted-foreground">
          {status === "published" ? "Published" : "Uploaded"} videos are locked. Undo it on the Publishing page.
        </p>
      )}
      <RemoveVideoButton videoId={videoId} title={title} published={status === "published" || uploaded} redirect="/videos" />

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this video?</DialogTitle>
            <DialogDescription>It stays in the studio, marked rejected, and won&apos;t enter the publishing queue.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} maxLength={2000} placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => run(() => rejectVideo(videoId, reason), () => setRejectOpen(false))}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
