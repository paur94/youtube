"use client";

import { startTransition, useActionState, useEffect, useEffectEvent, useId } from "react";
import { toast } from "sonner";

import { Field, SelectField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Character } from "@/db/schema";
import { CHARACTER_STATUS_LABELS, CHARACTER_STATUSES, type CharacterFormState } from "@/lib/production";
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
  const id = useId();
  const errors = state && !state.ok ? state.errors : undefined;

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
        label="Consistent visual description"
        hint="Added to every prompt this character appears in"
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
