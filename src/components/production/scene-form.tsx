"use client";

import { TriangleAlertIcon } from "lucide-react";
import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ProductionScene } from "@/db/schema";
import { findPromptConcerns, type SceneFormState } from "@/lib/production";
import { formatDialogue } from "@/lib/stories";
import { updateScene } from "@/server/actions/production";
import type { CharacterOption } from "@/server/queries/production";

export function SceneForm({
  scene,
  characters,
  linkedIds,
}: {
  scene: ProductionScene;
  characters: CharacterOption[];
  linkedIds: string[];
}) {
  const [state, formAction, pending] = useActionState<SceneFormState, FormData>(
    updateScene.bind(null, scene.id),
    null,
  );
  const [prompt, setPrompt] = useState(scene.visualPrompt);
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;
  const concerns = findPromptConcerns(prompt);

  const onResult = useEffectEvent((result: NonNullable<SceneFormState>) => {
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
    <form onSubmit={handleSubmit} className="grid gap-4" key={scene.updatedAt.toISOString()}>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field id={`${id}-title`} label="Title" error={errors?.title}>
          <Input id={`${id}-title`} name="title" required maxLength={160} defaultValue={scene.title} />
        </Field>
        <Field id={`${id}-duration`} label="Duration (s)" error={errors?.durationSeconds}>
          <Input
            id={`${id}-duration`}
            name="durationSeconds"
            type="number"
            min={1}
            max={600}
            required
            defaultValue={scene.durationSeconds}
          />
        </Field>
      </div>

      <Field id={`${id}-narration`} label="Narration" error={errors?.narration}>
        <Textarea id={`${id}-narration`} name="narration" rows={3} maxLength={8000} defaultValue={scene.narration} />
      </Field>
      <Field id={`${id}-dialogue`} label="Dialogue" hint="One line each: Name: line" error={errors?.dialogue}>
        <Textarea
          id={`${id}-dialogue`}
          name="dialogue"
          rows={3}
          maxLength={8000}
          defaultValue={formatDialogue(scene.dialogue)}
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-setting`} label="Setting" error={errors?.setting}>
          <Textarea id={`${id}-setting`} name="setting" rows={2} maxLength={2000} defaultValue={scene.setting} />
        </Field>
        <Field id={`${id}-action`} label="Action" error={errors?.action}>
          <Textarea id={`${id}-action`} name="action" rows={2} maxLength={4000} defaultValue={scene.action} />
        </Field>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">Characters in this scene</legend>
        {characters.length === 0 ? (
          <p className="text-xs text-muted-foreground">No characters in the library yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {characters.map((c) => (
              <label
                key={c.id}
                className="flex items-center gap-1.5 rounded-md border bg-background/40 px-2 py-1 text-sm has-checked:border-primary/60"
              >
                <input
                  type="checkbox"
                  name="characterIds"
                  value={c.id}
                  defaultChecked={linkedIds.includes(c.id)}
                  className="size-3.5 accent-primary"
                />
                {c.name}
                {c.status === "draft" && <span className="text-[10px] text-muted-foreground">draft</span>}
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Each linked character&apos;s library description is added to the prompt to keep them consistent.
        </p>
      </fieldset>

      <Field id={`${id}-prompt`} label="Visual generation prompt" error={errors?.visualPrompt}>
        <Textarea
          id={`${id}-prompt`}
          name="visualPrompt"
          rows={6}
          maxLength={6000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </Field>
      {concerns.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Automated generation is blocked until this is fixed</p>
            <ul className="list-disc pl-4 text-xs">
              {concerns.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <Field
        id={`${id}-negative`}
        label="Negative prompt"
        hint="Sent only to models that support it (Kling)"
        error={errors?.negativePrompt}
      >
        <Textarea id={`${id}-negative`} name="negativePrompt" rows={2} maxLength={2000} defaultValue={scene.negativePrompt} />
      </Field>
      <Field id={`${id}-notes`} label="Production notes" error={errors?.notes}>
        <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={2000} defaultValue={scene.notes} />
      </Field>

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save scene"}
        </Button>
      </div>
    </form>
  );
}
