"use client";

import {
  CheckCircle2Icon,
  RotateCcwIcon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
  WandSparklesIcon,
  XCircleIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState } from "react";
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
import { findMetadataConcerns, normalizeHashtags, type ShortMetadataState, type ShortStatus, TITLE_MAX } from "@/lib/shorts";
import {
  analyzeShort,
  applySuggestedMetadata,
  approveShort,
  deleteShort,
  rejectShort,
  reopenShort,
  setMetadataApproval,
  submitShortForReview,
  updateShortMetadata,
} from "@/server/actions/shorts";

export type MetadataFormValues = {
  title: string;
  description: string;
  hashtags: string[];
  playlist: string;
  hook: string;
  hookSeconds: number;
  publishOrder: number | null;
  notes: string;
};

export function MetadataForm({
  shortId,
  values,
  locked,
  approved,
  formKey,
}: {
  shortId: string;
  values: MetadataFormValues;
  locked: boolean;
  approved: boolean;
  formKey: string;
}) {
  const [state, formAction, pending] = useActionState<ShortMetadataState, FormData>(updateShortMetadata.bind(null, shortId), null);
  const [title, setTitle] = useState(values.title);
  const [description, setDescription] = useState(values.description);
  const [hashtags, setHashtags] = useState(values.hashtags.join(" "));
  const [hook, setHook] = useState(values.hook);
  // Server-side changes (e.g. "Apply suggestions") bump formKey; resync the controlled fields to the fresh values.
  const [syncedKey, setSyncedKey] = useState(formKey);
  if (syncedKey !== formKey) {
    setSyncedKey(formKey);
    setTitle(values.title);
    setDescription(values.description);
    setHashtags(values.hashtags.join(" "));
    setHook(values.hook);
  }
  const [approving, runApproval] = useAction();
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;
  const concerns = findMetadataConcerns({ title, description, hashtags: normalizeHashtags(hashtags), hook });

  const onResult = useEffectEvent((result: NonNullable<ShortMetadataState>) => {
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
          <Textarea
            id={`${id}-description`}
            name="description"
            rows={4}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field id={`${id}-hashtags`} label="Hashtags" hint="space or comma separated" error={errors?.hashtags}>
          <Input id={`${id}-hashtags`} name="hashtags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
          <Field id={`${id}-hook`} label="Opening hook" hint="on-screen text" error={errors?.hook}>
            <Input id={`${id}-hook`} name="hook" maxLength={120} value={hook} onChange={(e) => setHook(e.target.value)} />
          </Field>
          <Field id={`${id}-hookSeconds`} label="Hook (s)" error={errors?.hookSeconds}>
            <Input id={`${id}-hookSeconds`} name="hookSeconds" type="number" min={0.5} max={10} step={0.5} defaultValue={values.hookSeconds} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
          <Field id={`${id}-playlist`} label="Suggested playlist" error={errors?.playlist}>
            <Input id={`${id}-playlist`} name="playlist" maxLength={150} defaultValue={values.playlist} />
          </Field>
          <Field id={`${id}-order`} label="Publish #" error={errors?.publishOrder}>
            <Input id={`${id}-order`} name="publishOrder" type="number" min={1} max={999} defaultValue={values.publishOrder ?? ""} />
          </Field>
        </div>
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
          <Button type="button" variant="ghost" disabled={locked || approving} onClick={() => runApproval(() => setMetadataApproval(shortId, false))}>
            Remove approval
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={locked || approving || concerns.length > 0}
            title="Approves the saved metadata. Save your edits first."
            onClick={() => runApproval(() => setMetadataApproval(shortId, true))}
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

export function AnalyzeButton({ shortId, analyzed, disabled }: { shortId: string; analyzed: boolean; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button variant={analyzed ? "outline" : "default"} size="sm" disabled={disabled || pending} onClick={() => run(() => analyzeShort(shortId))}>
      <SparklesIcon />
      {pending ? "Analysing… (up to a minute)" : analyzed ? "Analyse again" : "Analyse with Claude"}
    </Button>
  );
}

export function ApplySuggestionsButton({ shortId, disabled }: { shortId: string; disabled?: boolean }) {
  const [pending, run] = useAction();
  return (
    <Button variant="outline" size="sm" disabled={disabled || pending} onClick={() => run(() => applySuggestedMetadata(shortId))}>
      <WandSparklesIcon />
      Apply suggestions
    </Button>
  );
}

export function ReviewActions({
  shortId,
  status,
  uploaded,
  blockers,
  title,
}: {
  shortId: string;
  status: ShortStatus;
  uploaded: boolean;
  blockers: string[];
  title: string;
}) {
  const [pending, run] = useAction();
  const [confirmed, setConfirmed] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState("");
  const router = useRouter();

  return (
    <div className="grid gap-3">
      {status === "draft" && (
        <>
          {blockers.length > 0 && (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {blockers.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || blockers.length > 0} onClick={() => run(() => submitShortForReview(shortId))}>
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
          {blockers.length > 0 ? (
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {blockers.map((b) => (
                <li key={b}>· {b}</li>
              ))}
            </ul>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
              />
              I watched the rendered 9:16 version with sound, and it is suitable for children.
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || blockers.length > 0 || !confirmed} onClick={() => run(() => approveShort(shortId, confirmed))}>
              <CheckCircle2Icon />
              Approve Short
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setRejectOpen(true)}>
              <XCircleIcon />
              Reject
            </Button>
          </div>
        </>
      )}
      {status !== "draft" && status !== "published" && !uploaded && (
        <Button variant="outline" className="w-fit" disabled={pending} onClick={() => run(() => reopenShort(shortId))}>
          <RotateCcwIcon />
          Back to draft
        </Button>
      )}
      {(status === "published" || uploaded) && (
        <p className="text-sm text-muted-foreground">
          {status === "published" ? "Published" : "Uploaded to YouTube"} Shorts are locked. Undo it on the Publishing page.
        </p>
      )}
      <Button variant="ghost" size="sm" className="w-fit text-muted-foreground" disabled={pending} onClick={() => setDeleteOpen(true)}>
        <Trash2Icon />
        Delete Short
      </Button>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this Short?</DialogTitle>
            <DialogDescription>It stays in the studio, marked rejected, and won&apos;t enter the publishing queue.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} maxLength={2000} placeholder="Why? (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pending} onClick={() => run(() => rejectShort(shortId, reason), () => setRejectOpen(false))}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the Short, its analysis and analytics. The production scene, the original clip and rendered files stay
              untouched. You can import the scene again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run(() => deleteShort(shortId), () => router.push("/shorts"))}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
