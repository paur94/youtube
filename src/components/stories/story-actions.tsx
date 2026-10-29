"use client";

import { CheckCircle2Icon, HistoryIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { StoryForm } from "@/components/stories/story-form";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Story } from "@/db/schema";
import { REVISION_SOURCE_LABELS, type RevisionSource, type StoryStatus } from "@/lib/stories";
import type { ActionResult } from "@/server/actions/ideas";
import { deleteStory, restoreRevision, setStoryApproval } from "@/server/actions/stories";
import type { IdeaOption } from "@/server/queries/stories";

function useAction() {
  const [pending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult>, onOk?: () => void) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          toast.success(result.message);
          onOk?.();
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }
  return [pending, run] as const;
}

export function EditBriefButton({ story, ideas }: { story: Story; ideas: IdeaOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <PencilIcon />
        Edit brief
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit brief</DialogTitle>
            <DialogDescription>
              Changes apply the next time you generate. The current story is kept as is.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <StoryForm
              ideas={ideas}
              story={story}
              onDone={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeleteStoryButton({ storyId, title }: { storyId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  const router = useRouter();

  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Delete story" onClick={() => setOpen(true)} disabled={pending}>
        <Trash2Icon />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the story, all of its revisions and its usage log. A linked
              idea is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => deleteStory(storyId), () => router.push("/stories"))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ApprovalPanel({
  storyId,
  status,
  hasContent,
  approvedAt,
}: {
  storyId: string;
  status: StoryStatus;
  hasContent: boolean;
  approvedAt: string | null;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, run] = useAction();

  if (status === "approved") {
    return (
      <div className="grid gap-3">
        <div className="flex items-start gap-2 text-sm">
          <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <p>
            Approved for production{approvedAt ? ` on ${approvedAt}` : ""}. Editing or regenerating
            sends it back to review.
          </p>
        </div>
        <Button variant="outline" disabled={pending} onClick={() => run(() => setStoryApproval(storyId, false))}>
          Move back to review
        </Button>
      </div>
    );
  }

  if (!hasContent) {
    return <p className="text-sm text-muted-foreground">Generate the story first, then review and approve it here.</p>;
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
        I have read the full story and checked it for age-appropriateness and originality.
      </label>
      <Button
        disabled={!confirmed || pending}
        onClick={() => run(() => setStoryApproval(storyId, true), () => setConfirmed(false))}
      >
        <CheckCircle2Icon />
        Approve for production
      </Button>
      <p className="text-xs text-muted-foreground">
        Approval only marks the story ready for the Production Studio. Nothing is published.
      </p>
    </div>
  );
}

type RevisionItem = {
  id: string;
  number: number;
  source: RevisionSource;
  title: string;
  instructions: string | null;
  model: string | null;
  createdAt: string;
};

export function RevisionList({ storyId, revisions }: { storyId: string; revisions: RevisionItem[] }) {
  const [pending, run] = useAction();

  if (revisions.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <HistoryIcon className="size-4" />
        No revisions yet
      </p>
    );
  }

  return (
    <ol className="grid gap-2">
      {revisions.map((revision, i) => (
        <li key={revision.id} className="rounded-lg border bg-background/40 p-2.5 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">
                #{revision.number} · {REVISION_SOURCE_LABELS[revision.source]}
                {i === 0 && <span className="ml-1.5 text-xs font-normal text-primary">current</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground" title={revision.title}>
                {revision.title}
              </p>
              <p className="text-xs text-muted-foreground">
                {revision.createdAt}
                {revision.model && ` · ${revision.model}`}
              </p>
              {revision.instructions && (
                <p className="mt-1 line-clamp-2 text-xs italic text-muted-foreground">“{revision.instructions}”</p>
              )}
            </div>
            {i > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(() => restoreRevision(storyId, revision.id))}
              >
                <RotateCcwIcon />
                Restore
              </Button>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
