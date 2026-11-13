"use client";

import { PlusIcon } from "lucide-react";
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
import { VisualStylePreset } from "@/components/visual-style-preset";
import type { Story } from "@/db/schema";
import { AGE_GROUP_LABELS, AGE_GROUPS } from "@/lib/ideas";
import {
  LANGUAGE_SUGGESTIONS,
  MAX_DURATION_SECONDS,
  MIN_DURATION_SECONDS,
  TONE_SUGGESTIONS,
  VISUAL_STYLE_SUGGESTIONS,
  type StoryFormState,
} from "@/lib/stories";
import { createStory, updateStoryBrief } from "@/server/actions/stories";
import type { CharacterOption } from "@/server/queries/production";
import type { BriefDefaults, IdeaOption } from "@/server/queries/stories";

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
    topic: idea.description,
    learningObjective: idea.learningObjective || undefined,
    targetDurationSeconds: FORMAT_DURATION[idea.format],
    notes: idea.notes.slice(0, 2000),
  };
}

export function StoryForm({
  ideas,
  story,
  initialIdeaId,
  lastBrief,
  library = [],
  onDone,
  onCancel,
}: {
  ideas: IdeaOption[];
  /** Tone, style, language and age of the previous brief, used when creating. */
  lastBrief?: BriefDefaults;
  /** Characters from the library that can be added to the brief with one click. */
  library?: CharacterOption[];
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
  // When creating, the previous brief's settings are the starting point and picking an idea
  // pre-fills the rest; the fields remount with new defaults.
  const defaults: Partial<Brief> = story ?? { ...lastBrief, ...briefFromIdea(selectedIdea) };

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
        {!story && selectedIdea && (
          <p className="text-xs text-muted-foreground">
            Pre-filled from the idea. Changes here apply to the story only.
          </p>
        )}
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
          <Field
            id={`${id}-duration`}
            label="Story duration"
            hint="Seconds"
            error={errors?.targetDurationSeconds}
          >
            <Input
              id={`${id}-duration`}
              name="targetDurationSeconds"
              type="number"
              inputMode="numeric"
              required
              min={MIN_DURATION_SECONDS}
              max={MAX_DURATION_SECONDS}
              step={1}
              defaultValue={defaults.targetDurationSeconds ?? 180}
              aria-invalid={!!errors?.targetDurationSeconds}
            />
          </Field>
        </div>

        <Field id={`${id}-topic`} label="Topic" error={errors?.topic}>
          <Textarea
            id={`${id}-topic`}
            name="topic"
            rows={3}
            required
            minLength={3}
            maxLength={2000}
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

        <CharactersField
          id={`${id}-characters`}
          defaultValue={defaults.characters ?? ""}
          library={library}
          error={errors?.characters}
        />

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

        <VisualStyleField
          id={`${id}-style`}
          defaultValue={defaults.visualStyle ?? VISUAL_STYLE_SUGGESTIONS[0]}
          error={errors?.visualStyle}
        />

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

function VisualStyleField({ id, defaultValue, error }: { id: string; defaultValue: string; error?: string[] }) {
  const [value, setValue] = useState(defaultValue);
  return (
    <Field id={id} label="Visual style" error={error}>
      <VisualStylePreset value={value} onSelect={setValue} />
      <Input
        id={id}
        name="visualStyle"
        required
        minLength={2}
        maxLength={160}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-invalid={!!error}
      />
    </Field>
  );
}

function CharactersField({
  id,
  defaultValue,
  library,
  error,
}: {
  id: string;
  defaultValue: string;
  library: CharacterOption[];
  error?: string[];
}) {
  const [value, setValue] = useState(defaultValue);
  const lines = value.split("\n").map((l) => l.trim().toLowerCase());
  // A character is listed when a line starts with its name, however the rest of the line reads.
  const listed = (c: CharacterOption) => lines.some((l) => l.startsWith(c.name.trim().toLowerCase()));

  function add(c: CharacterOption) {
    setValue((v) => (v.trim() ? `${v.trimEnd()}\n${c.name}` : c.name).slice(0, 2000));
  }

  return (
    <Field
      id={id}
      label="Main characters"
      hint="One per line · leave empty to let GPT invent them"
      error={error}
    >
      <Textarea
        id={id}
        name="characters"
        rows={3}
        maxLength={2000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={"Pip – a small yellow duckling who loves puddles\nGrandma Hen – patient and wise"}
      />
      {library.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">From your library:</span>
          {library.map((c) => (
            <Button
              key={c.id}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={listed(c)}
              onClick={() => add(c)}
            >
              <PlusIcon className="size-3" />
              {c.name}
            </Button>
          ))}
        </div>
      )}
    </Field>
  );
}
