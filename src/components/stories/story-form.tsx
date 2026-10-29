"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState } from "react";
import { toast } from "sonner";

import { Field, SelectField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Story } from "@/db/schema";
import { AGE_GROUP_LABELS, AGE_GROUPS } from "@/lib/ideas";
import {
  DURATION_PRESETS,
  formatDuration,
  LANGUAGE_SUGGESTIONS,
  TONE_SUGGESTIONS,
  VISUAL_STYLE_SUGGESTIONS,
  type StoryFormState,
} from "@/lib/stories";
import { createStory, updateStoryBrief } from "@/server/actions/stories";
import type { IdeaOption } from "@/server/queries/stories";

const NO_IDEA = "none";

const FORMAT_DURATION: Record<IdeaOption["format"], number> = { short: 45, standard: 180, long: 600 };

type Brief = Pick<
  Story,
  | "title"
  | "ageGroup"
  | "topic"
  | "learningObjective"
  | "characters"
  | "targetDurationSeconds"
  | "tone"
  | "visualStyle"
  | "language"
  | "notes"
>;

function briefFromIdea(idea: IdeaOption | undefined): Partial<Brief> {
  if (!idea) return {};
  return {
    title: idea.title,
    ageGroup: idea.ageGroup,
    topic: idea.description.slice(0, 300),
    targetDurationSeconds: FORMAT_DURATION[idea.format],
    notes: idea.notes.slice(0, 2000),
  };
}

export function StoryForm({
  ideas,
  story,
  initialIdeaId,
  onDone,
  onCancel,
}: {
  ideas: IdeaOption[];
  /** Present when editing an existing brief. */
  story?: Story;
  initialIdeaId?: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const action = story ? updateStoryBrief.bind(null, story.id) : createStory;
  const [state, formAction, pending] = useActionState<StoryFormState, FormData>(action, null);
  const [ideaId, setIdeaId] = useState(story?.ideaId ?? initialIdeaId ?? "");
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;

  const selectedIdea = ideas.find((i) => i.id === ideaId);
  // When creating, picking an idea pre-fills the brief; the fields remount with new defaults.
  const defaults: Partial<Brief> = story ?? briefFromIdea(selectedIdea);

  const onResult = useEffectEvent((result: NonNullable<StoryFormState>) => {
    if (result.ok) {
      toast.success(result.message);
      onDone?.();
    } else if (result.message) {
      toast.error(result.message);
    }
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
    <form onSubmit={handleSubmit} className="grid gap-4">
      <input type="hidden" name="ideaId" value={ideaId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-idea`}>
          Start from
          <span className="font-normal text-muted-foreground">· Optional</span>
        </Label>
        <Select value={ideaId || NO_IDEA} onValueChange={(v) => setIdeaId(v === NO_IDEA ? "" : v)}>
          <SelectTrigger id={`${id}-idea`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_IDEA}>Start from scratch</SelectItem>
            {ideas.map((idea) => (
              <SelectItem key={idea.id} value={idea.id}>
                {idea.title}
              </SelectItem>
            ))}
            {/* Keep a linked idea selectable even if it's archived now. */}
            {story?.ideaId && !selectedIdea && (
              <SelectItem value={story.ideaId}>Linked idea (archived)</SelectItem>
            )}
          </SelectContent>
        </Select>
        {errors?.ideaId?.[0] && <p className="text-xs text-destructive">{errors.ideaId[0]}</p>}
      </div>

      <div key={story ? story.id : ideaId} className="grid gap-4">
        <Field id={`${id}-title`} label="Story title" hint="Working title" error={errors?.title}>
          <Input
            id={`${id}-title`}
            name="title"
            required
            minLength={3}
            maxLength={120}
            defaultValue={defaults.title}
            placeholder="e.g. Pip the puddle duck learns to share"
            aria-invalid={!!errors?.title}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id={`${id}-age`}
            name="ageGroup"
            label="Target age range"
            defaultValue={defaults.ageGroup ?? "3-5"}
            options={AGE_GROUPS.map((v) => [v, AGE_GROUP_LABELS[v]])}
          />
          <SelectField
            id={`${id}-duration`}
            name="targetDurationSeconds"
            label="Story duration"
            defaultValue={String(defaults.targetDurationSeconds ?? 180)}
            options={DURATION_PRESETS.map((s) => [String(s), formatDuration(s)])}
          />
        </div>
        {errors?.targetDurationSeconds?.[0] && (
          <p className="-mt-2 text-xs text-destructive">{errors.targetDurationSeconds[0]}</p>
        )}

        <Field id={`${id}-topic`} label="Topic" error={errors?.topic}>
          <Textarea
            id={`${id}-topic`}
            name="topic"
            rows={2}
            required
            minLength={3}
            maxLength={300}
            defaultValue={defaults.topic}
            placeholder="What is the story about?"
            aria-invalid={!!errors?.topic}
          />
        </Field>

        <Field id={`${id}-objective`} label="Learning objective" error={errors?.learningObjective}>
          <Input
            id={`${id}-objective`}
            name="learningObjective"
            required
            minLength={3}
            maxLength={500}
            defaultValue={defaults.learningObjective}
            placeholder="e.g. Count from one to five; taking turns is fair"
            aria-invalid={!!errors?.learningObjective}
          />
        </Field>

        <Field
          id={`${id}-characters`}
          label="Main characters"
          hint="One per line · leave empty to let Claude invent them"
          error={errors?.characters}
        >
          <Textarea
            id={`${id}-characters`}
            name="characters"
            rows={3}
            maxLength={2000}
            defaultValue={defaults.characters}
            placeholder={"Pip – a small yellow duckling who loves puddles\nGrandma Hen – patient and wise"}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-tone`} label="Tone" error={errors?.tone}>
            <Input
              id={`${id}-tone`}
              name="tone"
              required
              minLength={2}
              maxLength={80}
              list={`${id}-tone-list`}
              defaultValue={defaults.tone ?? TONE_SUGGESTIONS[0]}
              aria-invalid={!!errors?.tone}
            />
            <Suggestions id={`${id}-tone-list`} values={TONE_SUGGESTIONS} />
          </Field>
          <Field id={`${id}-language`} label="Language" error={errors?.language}>
            <Input
              id={`${id}-language`}
              name="language"
              required
              minLength={2}
              maxLength={40}
              list={`${id}-language-list`}
              defaultValue={defaults.language ?? "English"}
              aria-invalid={!!errors?.language}
            />
            <Suggestions id={`${id}-language-list`} values={LANGUAGE_SUGGESTIONS} />
          </Field>
        </div>

        <Field id={`${id}-style`} label="Visual style" error={errors?.visualStyle}>
          <Input
            id={`${id}-style`}
            name="visualStyle"
            required
            minLength={2}
            maxLength={160}
            list={`${id}-style-list`}
            defaultValue={defaults.visualStyle ?? VISUAL_STYLE_SUGGESTIONS[0]}
            aria-invalid={!!errors?.visualStyle}
          />
          <Suggestions id={`${id}-style-list`} values={VISUAL_STYLE_SUGGESTIONS} />
        </Field>

        <Field id={`${id}-notes`} label="Additional notes" hint="Optional" error={errors?.notes}>
          <Textarea
            id={`${id}-notes`}
            name="notes"
            rows={2}
            maxLength={2000}
            defaultValue={defaults.notes}
            placeholder="Songs, running jokes, things to avoid…"
          />
        </Field>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link href="/stories">Cancel</Link>
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : story ? "Save brief" : "Create story project"}
        </Button>
      </div>
    </form>
  );
}

function Suggestions({ id, values }: { id: string; values: string[] }) {
  return (
    <datalist id={id}>
      {values.map((v) => (
        <option key={v} value={v} />
      ))}
    </datalist>
  );
}
