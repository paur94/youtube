"use client";

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  LibraryIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  formatDialogue,
  formatDuration,
  parseDialogue,
  parseList,
  REVIEW_CHECK_LABELS,
  REVIEW_CHECKS,
  sceneLookOf,
  sumSceneDurations,
  type StoryContent,
  type StoryScene,
} from "@/lib/stories";
import { cn } from "@/lib/utils";
import type { CharacterOption } from "@/server/queries/production";

type Props = {
  value: StoryContent;
  onChange: (next: StoryContent) => void;
  /** Bumped whenever `value` is replaced from the server, to reset blur-committed fields. */
  version: number;
  targetDurationSeconds: number;
  /** Library characters: their descriptions live in the library, and scenes pick one of their looks. */
  library: CharacterOption[];
  disabled?: boolean;
};

// Radix Select needs a non-empty value for the "no look picked" option; look labels can't be empty.
const DEFAULT_LOOK = "";
const DEFAULT_LOOK_VALUE = "__default__";

const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

export function StoryEditor({ value, onChange, version, targetDurationSeconds, library, disabled }: Props) {
  const id = useId();
  const libraryByName = new Map(library.map((c) => [nameKey(c.name), c]));
  // Scene cards have blur-committed fields, so they remount when scenes shift position.
  const [layoutKey, setLayoutKey] = useState(0);
  const set = <K extends keyof StoryContent>(key: K, v: StoryContent[K]) => onChange({ ...value, [key]: v });
  const sceneTotal = sumSceneDurations(value);

  function updateScene(index: number, patch: Partial<StoryScene>) {
    set(
      "scenes",
      value.scenes.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)),
    );
  }

  function removeScene(index: number) {
    setLayoutKey((k) => k + 1);
    set(
      "scenes",
      value.scenes.filter((_, i) => i !== index).map((scene, i) => ({ ...scene, number: i + 1 })),
    );
  }

  function addScene() {
    const last = value.scenes.at(-1);
    set("scenes", [
      ...value.scenes,
      {
        number: value.scenes.length + 1,
        title: "New scene",
        durationSeconds: 20,
        setting: last?.setting ?? "",
        action: "",
        narration: "",
        characters: [],
        dialogue: [],
        visualPrompt: "",
        productionNotes: "",
        soundEffects: [],
        musicMood: last?.musicMood ?? "",
        looks: [],
      },
    ]);
  }

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-6 disabled:opacity-60">
      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>
            Estimated {formatDuration(value.estimatedDurationSeconds)} · scenes add up to{" "}
            {formatDuration(sceneTotal)} · target {formatDuration(targetDurationSeconds)}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field id={`${id}-title`} label="Title">
            <Input id={`${id}-title`} value={value.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field id={`${id}-premise`} label="Premise">
            <Textarea
              id={`${id}-premise`}
              rows={3}
              value={value.premise}
              onChange={(e) => set("premise", e.target.value)}
            />
          </Field>
          <Field id={`${id}-outcome`} label="Learning outcome">
            <Textarea
              id={`${id}-outcome`}
              rows={2}
              value={value.learningOutcome}
              onChange={(e) => set("learningOutcome", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Field id={`${id}-music`} label="Overall music mood">
              <Input
                id={`${id}-music`}
                value={value.musicMood}
                onChange={(e) => set("musicMood", e.target.value)}
              />
            </Field>
            <Field id={`${id}-duration`} label="Estimated duration" hint="seconds">
              <Input
                id={`${id}-duration`}
                type="number"
                min={0}
                value={value.estimatedDurationSeconds}
                onChange={(e) => set("estimatedDurationSeconds", Number(e.target.value) || 0)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Story arc</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {(["beginning", "middle", "ending"] as const).map((part) => (
            <Field key={part} id={`${id}-${part}`} label={part[0].toUpperCase() + part.slice(1)}>
              <Textarea
                id={`${id}-${part}`}
                rows={3}
                value={value[part]}
                onChange={(e) => set(part, e.target.value)}
              />
            </Field>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Characters</CardTitle>
          <CardDescription>
            The visual description is reused in every scene prompt for consistency. Library characters keep their
            descriptions in the library; pick their look per scene in the storyboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {value.characters.map((character, i) => {
            const linked = libraryByName.get(nameKey(character.name));
            return (
            <div key={i} className="grid gap-3 rounded-lg border bg-background/40 p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field id={`${id}-char-${i}-name`} label="Name">
                  <Input
                    id={`${id}-char-${i}-name`}
                    value={character.name}
                    onChange={(e) => set("characters", replaceAt(value.characters, i, { ...character, name: e.target.value }))}
                  />
                </Field>
                <Field id={`${id}-char-${i}-role`} label="Role">
                  <Input
                    id={`${id}-char-${i}-role`}
                    value={character.role}
                    onChange={(e) => set("characters", replaceAt(value.characters, i, { ...character, role: e.target.value }))}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${character.name || "character"}`}
                  onClick={() => set("characters", value.characters.filter((_, j) => j !== i))}
                >
                  <Trash2Icon />
                </Button>
              </div>
              {linked ? (
                <Link
                  href={`/characters/${linked.id}`}
                  className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
                >
                  <LibraryIcon className="size-3.5" />
                  From your character library
                  {linked.looks.length > 0 && ` · ${linked.looks.length + 1} looks`}
                </Link>
              ) : (
              <>
              <Field id={`${id}-char-${i}-desc`} label="Personality">
                <Textarea
                  id={`${id}-char-${i}-desc`}
                  rows={2}
                  value={character.description}
                  onChange={(e) =>
                    set("characters", replaceAt(value.characters, i, { ...character, description: e.target.value }))
                  }
                />
              </Field>
              <Field id={`${id}-char-${i}-look`} label="Visual description">
                <Textarea
                  id={`${id}-char-${i}-look`}
                  rows={2}
                  value={character.visualDescription}
                  onChange={(e) =>
                    set(
                      "characters",
                      replaceAt(value.characters, i, { ...character, visualDescription: e.target.value }),
                    )
                  }
                />
              </Field>
              </>
              )}
            </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            className="justify-self-start"
            onClick={() =>
              set("characters", [...value.characters, { name: "", role: "", description: "", visualDescription: "" }])
            }
          >
            <PlusIcon />
            Add character
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Full narration</CardTitle>
          <CardDescription>The complete voice-over script, start to finish.</CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            aria-label="Full narration"
            rows={16}
            className="leading-relaxed"
            value={value.narration}
            onChange={(e) => set("narration", e.target.value)}
          />
        </CardContent>
      </Card>

      <section className="grid gap-3" aria-labelledby={`${id}-storyboard`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={`${id}-storyboard`} className="text-lg font-semibold">
            Storyboard
          </h2>
          <p className="text-sm text-muted-foreground">
            {value.scenes.length} scenes · {formatDuration(sceneTotal)}
          </p>
        </div>
        {value.scenes.map((scene, i) => (
          <SceneCard
            key={`${version}-${layoutKey}-${i}`}
            id={`${id}-scene-${i}`}
            scene={scene}
            library={libraryByName}
            onChange={(patch) => updateScene(i, patch)}
            onRemove={() => removeScene(i)}
          />
        ))}
        <Button type="button" variant="outline" className="justify-self-start" onClick={addScene}>
          <PlusIcon />
          Add scene
        </Button>
      </section>

      <ReviewChecklist checklist={value.reviewChecklist} />
    </fieldset>
  );
}

function SceneCard({
  id,
  scene,
  library,
  onChange,
  onRemove,
}: {
  id: string;
  scene: StoryScene;
  library: Map<string, CharacterOption>;
  onChange: (patch: Partial<StoryScene>) => void;
  onRemove: () => void;
}) {
  const withLooks = scene.characters.flatMap((name) => {
    const character = library.get(nameKey(name));
    return character && character.looks.length > 0 ? [{ name, character }] : [];
  });

  function pickLook(name: string, look: string) {
    const others = scene.looks.filter((l) => nameKey(l.character) !== nameKey(name));
    onChange({ looks: look === DEFAULT_LOOK ? others : [...others, { character: name, look }] });
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(scene.visualPrompt);
      toast.success("Visual prompt copied");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader className="grid-cols-[auto_1fr_7rem_auto] items-end gap-3">
        <span className="flex size-8 items-center justify-center self-end rounded-lg bg-primary/10 text-sm font-semibold text-primary">
          {scene.number}
        </span>
        <Field id={`${id}-title`} label="Scene title">
          <Input id={`${id}-title`} value={scene.title} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field id={`${id}-duration`} label="Seconds">
          <Input
            id={`${id}-duration`}
            type="number"
            min={0}
            value={scene.durationSeconds}
            onChange={(e) => onChange({ durationSeconds: Number(e.target.value) || 0 })}
          />
        </Field>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove scene ${scene.number}`} onClick={onRemove}>
          <Trash2Icon />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Field id={`${id}-setting`} label="Setting">
          <Textarea id={`${id}-setting`} rows={3} value={scene.setting} onChange={(e) => onChange({ setting: e.target.value })} />
        </Field>
        <Field id={`${id}-action`} label="Action" hint="Shot plan with timed beats">
          <Textarea id={`${id}-action`} rows={7} value={scene.action} onChange={(e) => onChange({ action: e.target.value })} />
        </Field>
        <Field id={`${id}-narration`} label="Narration">
          <Textarea
            id={`${id}-narration`}
            rows={3}
            value={scene.narration}
            onChange={(e) => onChange({ narration: e.target.value })}
          />
        </Field>
        {/* Parsed on blur so typing isn't reformatted mid-line. */}
        <Field id={`${id}-dialogue`} label="Dialogue" hint="One line each, “Name: line”">
          <Textarea
            id={`${id}-dialogue`}
            rows={Math.max(2, scene.dialogue.length)}
            defaultValue={formatDialogue(scene.dialogue)}
            onBlur={(e) => onChange({ dialogue: parseDialogue(e.target.value) })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-characters`} label="Characters in scene" hint="Comma-separated">
            <Input
              id={`${id}-characters`}
              defaultValue={scene.characters.join(", ")}
              onBlur={(e) => onChange({ characters: parseList(e.target.value) })}
            />
          </Field>
          <Field id={`${id}-sfx`} label="Sound effects" hint="Comma-separated">
            <Input
              id={`${id}-sfx`}
              defaultValue={scene.soundEffects.join(", ")}
              onBlur={(e) => onChange({ soundEffects: parseList(e.target.value) })}
            />
          </Field>
        </div>
        {withLooks.length > 0 && (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Looks in this scene</span>
            <div className="flex flex-wrap gap-2">
              {withLooks.map(({ name, character }) => {
                // A label that is no longer in the library falls back to the default look on import.
                const picked = sceneLookOf(scene, name);
                const known = picked ? character.looks.find((l) => nameKey(l.label) === nameKey(picked)) : undefined;
                return (
                  <div key={name} className="flex items-center gap-1.5 rounded-md border bg-background/40 py-1 pr-1 pl-2">
                    <span className="text-xs font-medium">{name}</span>
                    <Select
                      value={known?.label ?? DEFAULT_LOOK_VALUE}
                      onValueChange={(v) => pickLook(name, v === DEFAULT_LOOK_VALUE ? DEFAULT_LOOK : v)}
                    >
                      <SelectTrigger size="sm" aria-label={`Look for ${name}`} className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_LOOK_VALUE}>Default look</SelectItem>
                        {character.looks.map((l) => (
                          <SelectItem key={l.id} value={l.label}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <Field id={`${id}-music`} label="Music mood">
          <Input id={`${id}-music`} value={scene.musicMood} onChange={(e) => onChange({ musicMood: e.target.value })} />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${id}-prompt`} className="text-sm font-medium">
              Visual prompt
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={copyPrompt}>
              <CopyIcon />
              Copy
            </Button>
          </div>
          <Textarea
            id={`${id}-prompt`}
            rows={4}
            className="font-mono text-xs"
            value={scene.visualPrompt}
            onChange={(e) => onChange({ visualPrompt: e.target.value })}
          />
        </div>
        <Field id={`${id}-production-notes`} label="Production notes" hint="Keyframe and video steps">
          <Textarea
            id={`${id}-production-notes`}
            rows={6}
            className="font-mono text-xs"
            value={scene.productionNotes}
            onChange={(e) => onChange({ productionNotes: e.target.value })}
          />
        </Field>
      </CardContent>
    </Card>
  );
}

function ReviewChecklist({ checklist }: { checklist: StoryContent["reviewChecklist"] }) {
  const byCheck = new Map(checklist.map((item) => [item.check, item]));
  const concerns = checklist.filter((item) => item.status === "concern").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Age-appropriateness and originality review</CardTitle>
        <CardDescription>
          The model&apos;s self-review of this draft. It is advisory only: read the full story yourself
          before approving.{" "}
          {concerns > 0 && (
            <span className="font-medium text-amber-300">
              {concerns} {concerns === 1 ? "concern" : "concerns"} flagged.
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2">
          {REVIEW_CHECKS.map((check) => {
            const item = byCheck.get(check);
            const concern = item?.status === "concern";
            return (
              <li
                key={check}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border p-2.5 text-sm",
                  concern && "border-amber-500/40 bg-amber-500/5",
                )}
              >
                {item && !concern ? (
                  <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                ) : (
                  <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">{REVIEW_CHECK_LABELS[check]}</p>
                  <p className="text-xs text-muted-foreground">{item ? item.note : "Not reported by the model — check manually."}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function replaceAt<T>(items: T[], index: number, item: T) {
  return items.map((existing, i) => (i === index ? item : existing));
}
