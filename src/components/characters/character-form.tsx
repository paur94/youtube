"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { startTransition, useActionState, useEffect, useEffectEvent, useId, useState } from "react";
import { toast } from "sonner";

import { Field, SelectField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Character } from "@/db/schema";
import { CHARACTER_STATUS_LABELS, CHARACTER_STATUSES, type CharacterFormState, type CharacterLook } from "@/lib/production";
import { createCharacter, updateCharacter } from "@/server/actions/characters";

export function CharacterForm({
  character,
  onDone,
  onCancel,
}: {
  character?: Character;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const action = character ? updateCharacter.bind(null, character.id) : createCharacter;
  const [state, formAction, pending] = useActionState<CharacterFormState, FormData>(action, null);
  const [looks, setLooks] = useState<CharacterLook[]>(character?.looks ?? []);
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;

  function changeLook(lookId: string, change: Partial<CharacterLook>) {
    setLooks(looks.map((l) => (l.id === lookId ? { ...l, ...change } : l)));
  }

  const onResult = useEffectEvent((result: NonNullable<CharacterFormState>) => {
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={`${id}-name`} label="Name" error={errors?.name}>
          <Input id={`${id}-name`} name="name" required maxLength={80} defaultValue={character?.name} />
        </Field>
        <Field id={`${id}-role`} label="Role" error={errors?.role}>
          <Input
            id={`${id}-role`}
            name="role"
            maxLength={160}
            defaultValue={character?.role}
            placeholder="e.g. Protagonist, helper"
          />
        </Field>
      </div>
      <Field id={`${id}-description`} label="Personality" error={errors?.description}>
        <Textarea id={`${id}-description`} name="description" rows={2} maxLength={2000} defaultValue={character?.description} />
      </Field>
      <Field
        id={`${id}-visual`}
        label="Default look"
        hint="Added to every prompt this character appears in, unless the scene picks another look"
        error={errors?.visualDescription}
      >
        <Textarea
          id={`${id}-visual`}
          name="visualDescription"
          rows={4}
          required
          minLength={10}
          maxLength={2000}
          defaultValue={character?.visualDescription}
          placeholder="Species or age, body shape, colours, hair, clothing, distinctive details. Original designs only. Don't reference existing characters or artists."
        />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-medium">
          Other looks <span className="font-normal text-muted-foreground">· another outfit, age or season, picked per scene</span>
        </legend>
        <input type="hidden" name="looks" value={JSON.stringify(looks)} />
        {looks.map((look, i) => (
          <div key={look.id} className="grid gap-2 rounded-md border bg-background/40 p-2">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Look ${i + 1} name`}
                value={look.label}
                onChange={(e) => changeLook(look.id, { label: e.target.value })}
                required
                maxLength={80}
                placeholder="e.g. Sport outfit"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove look ${look.label || i + 1}`}
                onClick={() => setLooks(looks.filter((l) => l.id !== look.id))}
              >
                <Trash2Icon />
              </Button>
            </div>
            <Textarea
              aria-label={`Look ${i + 1} description`}
              value={look.visualDescription}
              onChange={(e) => changeLook(look.id, { visualDescription: e.target.value })}
              rows={3}
              required
              minLength={10}
              maxLength={2000}
              placeholder="The full look, like the default one: body, colours, hair and this outfit."
            />
          </div>
        ))}
        {errors?.looks?.[0] && <p className="text-xs text-destructive">{errors.looks[0]}</p>}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={looks.length >= 20}
          onClick={() => setLooks([...looks, { id: crypto.randomUUID(), label: "", visualDescription: "" }])}
        >
          <PlusIcon />
          Add look
        </Button>
        {looks.length < (character?.looks.length ?? 0) && (
          <p className="text-xs text-muted-foreground">Scenes using a removed look go back to the default look.</p>
        )}
      </fieldset>
      <Field id={`${id}-notes`} label="Notes" error={errors?.notes}>
        <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={2000} defaultValue={character?.notes} />
      </Field>
      <SelectField
        id={`${id}-status`}
        name="status"
        label="Status"
        defaultValue={character?.status ?? "draft"}
        options={CHARACTER_STATUSES.map((s) => [s, CHARACTER_STATUS_LABELS[s]])}
      />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : character ? "Save character" : "Add character"}
        </Button>
      </div>
    </form>
  );
}
