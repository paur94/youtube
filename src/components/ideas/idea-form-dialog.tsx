"use client";

import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState } from "react";
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
  ORIGINALITY_LABELS,
  ORIGINALITY_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
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
            Capture a video concept in a few words. Everything here is carried into the story brief when you develop it.
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [seenErrors, setSeenErrors] = useState(errors);
  // Open the collapsed section once when one of its fields fails validation.
  if (errors !== seenErrors) {
    setSeenErrors(errors);
    if (errors?.sourceUrl || errors?.tags || errors?.notes) setMoreOpen(true);
  }

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

      <Field
        id={`${id}-description`}
        label="Concept"
        hint="Becomes the story topic"
        error={errors?.description}
      >
        <Textarea
          id={`${id}-description`}
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={idea?.description}
          placeholder="What happens in the video?"
        />
      </Field>

      <Field
        id={`${id}-objective`}
        label="Learning objective"
        hint="Optional · can be added in the story brief"
        error={errors?.learningObjective}
      >
        <Input
          id={`${id}-objective`}
          name="learningObjective"
          maxLength={500}
          defaultValue={idea?.learningObjective}
          placeholder="e.g. Count from one to five; taking turns is fair"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
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
      </div>

      {/* Collapsed fields still submit, so their values are kept when editing. */}
      <details
        open={moreOpen}
        onToggle={(e) => setMoreOpen(e.currentTarget.open)}
        className="group rounded-lg border px-3 py-2"
      >
        <summary className="cursor-pointer text-sm font-medium select-none">
          More details
          <span className="ml-1.5 font-normal text-muted-foreground">
            · Category, priority, originality, source, tags, notes, YouTube compliance
          </span>
        </summary>
        <div className="grid gap-4 pt-3 pb-1">
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              id={`${id}-category`}
              name="category"
              label="Category"
              defaultValue={idea?.category ?? "learning"}
              options={CATEGORIES.map((v) => [v, CATEGORY_LABELS[v]])}
            />
            <SelectField
              id={`${id}-priority`}
              name="priority"
              label="Priority"
              defaultValue={idea?.priority ?? "medium"}
              options={PRIORITIES.map((v) => [v, PRIORITY_LABELS[v]])}
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

          <Field id={`${id}-notes`} label="Notes" hint="Carried into the story brief" error={errors?.notes}>
            <Textarea
              id={`${id}-notes`}
              name="notes"
              rows={2}
              maxLength={5000}
              defaultValue={idea?.notes}
              placeholder="References, music ideas, things to avoid…"
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
        </div>
      </details>

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
