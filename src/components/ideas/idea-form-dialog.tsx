"use client";

import { startTransition, useActionState, useEffect, useEffectEvent, useId } from "react";
import { toast } from "sonner";

import { Field, SelectField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Idea } from "@/db/schema";
import {
  AGE_GROUP_LABELS,
  AGE_GROUPS,
  CATEGORIES,
  CATEGORY_LABELS,
  FORMAT_LABELS,
  IDEA_STATUSES,
  ORIGINALITY_LABELS,
  ORIGINALITY_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  VIDEO_FORMATS,
  type IdeaFormState,
} from "@/lib/ideas";
import { createIdea, updateIdea } from "@/server/actions/ideas";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idea?: Idea;
};

export function IdeaFormDialog({ open, onOpenChange, idea }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{idea ? "Edit idea" : "New idea"}</DialogTitle>
          <DialogDescription>
            Capture a video concept. You can refine it into a story in the Story Workshop later.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so form state resets each time. */}
        <IdeaForm idea={idea} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function IdeaForm({ idea, onDone }: { idea?: Idea; onDone: () => void }) {
  const action = idea ? updateIdea.bind(null, idea.id) : createIdea;
  const [state, formAction, pending] = useActionState<IdeaFormState, FormData>(action, null);
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;

  const onResult = useEffectEvent((result: NonNullable<IdeaFormState>) => {
    if (result.ok) {
      toast.success(result.message);
      onDone();
    } else if (result.message) {
      toast.error(result.message);
    }
  });

  useEffect(() => {
    if (state) onResult(state);
  }, [state]);

  // Submitting manually (instead of <form action>) stops React from resetting the
  // fields, so the user's input survives a validation error.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <Field id={`${id}-title`} label="Title" error={errors?.title}>
        <Input
          id={`${id}-title`}
          name="title"
          required
          minLength={3}
          maxLength={120}
          defaultValue={idea?.title}
          placeholder="e.g. Counting ducks at the pond"
          aria-invalid={!!errors?.title}
        />
      </Field>

      <Field id={`${id}-description`} label="Description" error={errors?.description}>
        <Textarea
          id={`${id}-description`}
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={idea?.description}
          placeholder="What happens in the video? What will kids learn?"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id={`${id}-category`}
          name="category"
          label="Category"
          defaultValue={idea?.category ?? "learning"}
          options={CATEGORIES.map((v) => [v, CATEGORY_LABELS[v]])}
        />
        <SelectField
          id={`${id}-age`}
          name="ageGroup"
          label="Target age range"
          defaultValue={idea?.ageGroup ?? "3-5"}
          options={AGE_GROUPS.map((v) => [v, AGE_GROUP_LABELS[v]])}
        />
        <SelectField
          id={`${id}-format`}
          name="format"
          label="Format"
          defaultValue={idea?.format ?? "standard"}
          options={VIDEO_FORMATS.map((v) => [v, FORMAT_LABELS[v]])}
        />
        <SelectField
          id={`${id}-priority`}
          name="priority"
          label="Priority"
          defaultValue={idea?.priority ?? "medium"}
          options={PRIORITIES.map((v) => [v, PRIORITY_LABELS[v]])}
        />
        <SelectField
          id={`${id}-status`}
          name="status"
          label="Workflow status"
          defaultValue={idea?.status ?? "draft"}
          options={IDEA_STATUSES.map((v) => [v, STATUS_LABELS[v]])}
        />
        <SelectField
          id={`${id}-originality`}
          name="originalityStatus"
          label="Originality review"
          defaultValue={idea?.originalityStatus ?? "not_reviewed"}
          options={ORIGINALITY_STATUSES.map((v) => [v, ORIGINALITY_LABELS[v]])}
        />
      </div>

      <Field
        id={`${id}-source`}
        label="Source URL"
        hint="Optional · where the idea came from"
        error={errors?.sourceUrl}
      >
        <Input
          id={`${id}-source`}
          name="sourceUrl"
          type="url"
          maxLength={2000}
          defaultValue={idea?.sourceUrl ?? ""}
          placeholder="https://…"
          aria-invalid={!!errors?.sourceUrl}
        />
      </Field>

      <Field id={`${id}-tags`} label="Tags" hint="Comma-separated" error={errors?.tags}>
        <Input
          id={`${id}-tags`}
          name="tags"
          defaultValue={idea?.tags.join(", ")}
          placeholder="animals, counting, songs"
        />
      </Field>

      <Field id={`${id}-notes`} label="Notes" error={errors?.notes}>
        <Textarea
          id={`${id}-notes`}
          name="notes"
          rows={2}
          maxLength={5000}
          defaultValue={idea?.notes}
          placeholder="References, music ideas, character notes…"
        />
      </Field>

      <fieldset className="grid gap-2 rounded-lg border p-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          YouTube compliance
        </legend>
        <Checkbox
          name="madeForKids"
          defaultChecked={idea?.madeForKids ?? true}
          label="Made for kids (COPPA)"
        />
        <Checkbox
          name="containsSyntheticMedia"
          defaultChecked={idea?.containsSyntheticMedia ?? true}
          label="Contains realistic AI-generated content (disclosure)"
        />
      </fieldset>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : idea ? "Save changes" : "Create idea"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="size-4 rounded border-input accent-primary"
      />
      {label}
    </label>
  );
}
