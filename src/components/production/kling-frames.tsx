"use client";

import { ArrowDownIcon, ArrowUpIcon, ImagePlusIcon, SaveIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { AssetStatusBadge } from "@/components/production/badges";
import { AssetPreview } from "@/components/production/asset-preview";
import { ImportAssetDialog } from "@/components/production/import-asset-dialog";
import { useAction } from "@/components/production/use-action";
import type { ReferenceCandidate } from "@/components/qc/qc-actions";
import { Button } from "@/components/ui/button";
import {
  checkKlingImageCounts,
  KLING_IMAGE_RULES,
  KLING_IMAGE_TYPES,
  KLING_MAX_IMAGES,
  KLING_MAX_MIDDLE_IMAGES,
  type SceneFrames,
} from "@/lib/kling";
import { cn } from "@/lib/utils";
import { setSceneFrames } from "@/server/actions/production";

/** True when the stored type is one Kling accepts; unknown types pass and are checked on the server. */
export function klingAccepts(contentType: string | null | undefined) {
  return !contentType || (KLING_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function sameFrames(a: SceneFrames, b: SceneFrames) {
  return a.endAssetId === b.endAssetId && a.middleAssetIds.length === b.middleAssetIds.length && a.middleAssetIds.every((id, i) => id === b.middleAssetIds[i]);
}

type Slot = { kind: "middle"; index: number } | { kind: "end" };

/**
 * Kling 4.0 keyframes for one scene: the start image (chosen above), ordered middle images and an end
 * image, numbered as Kling sees them (@image_1 …). Controlled: the panel owns the selection so it can hold
 * back generation until the selection is saved.
 */
export function KlingFramesPicker({
  sceneId,
  candidates,
  startAssetId,
  saved,
  value,
  onChange,
}: {
  sceneId: string;
  candidates: ReferenceCandidate[];
  /** Start image chosen in the generation panel; shown as @image_1 and excluded from the other slots. */
  startAssetId: string;
  /** Selection stored on the scene, to tell unsaved changes apart. */
  saved: SceneFrames;
  value: SceneFrames;
  onChange: (next: SceneFrames) => void;
}) {
  const [adding, setAdding] = useState<Slot | null>(null);
  const [pending, run] = useAction();
  const byId = new Map(candidates.map((c) => [c.id, c]));
  // Images that dropped out of the candidates (rejected or deleted) still count until they're removed here.
  const used = new Set([startAssetId, ...value.middleAssetIds, ...(value.endAssetId ? [value.endAssetId] : [])]);
  const dirty = !sameFrames(value, saved);
  const total = 1 + value.middleAssetIds.length + (value.endAssetId ? 1 : 0);
  const problem = checkKlingImageCounts({ start: true, middle: value.middleAssetIds.length, end: Boolean(value.endAssetId) });
  const endNumber = 2 + value.middleAssetIds.length;

  function setMiddle(middleAssetIds: string[]) {
    onChange({ ...value, middleAssetIds });
  }

  function move(index: number, delta: number) {
    const next = [...value.middleAssetIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setMiddle(next);
  }

  function pick(id: string) {
    if (!adding) return;
    if (adding.kind === "end") onChange({ ...value, endAssetId: id });
    else {
      const next = [...value.middleAssetIds];
      next.splice(adding.index, 0, id);
      setMiddle(next);
    }
    setAdding(null);
  }

  const start = byId.get(startAssetId);
  const groups = [...new Set(candidates.map((c) => c.group))];

  return (
    <div className="grid gap-3 rounded-md border border-dashed p-3">
      <div className="grid gap-1">
        <h4 className="text-sm font-medium">Keyframes for Kling 4.0</h4>
        <p className="text-xs text-muted-foreground">
          The clip opens on the start image, passes through the middle images in order and ends on the end image.
          Kling numbers them @image_1, @image_2, … in that order; the prompt explains each one. Up to {KLING_MAX_IMAGES} images in
          total ({KLING_MAX_MIDDLE_IMAGES} middle at most). Each must be {KLING_IMAGE_RULES}.
        </p>
      </div>

      {/* Start */}
      <FrameRow number={1} title="Start image" hint="Chosen above as the start image.">
        {start ? <Thumb candidate={start} /> : <p className="text-xs text-muted-foreground">Pick a start image above.</p>}
      </FrameRow>

      {/* Middle */}
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h5 className="text-xs font-medium">Middle images · in order</h5>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={value.middleAssetIds.length >= KLING_MAX_MIDDLE_IMAGES}
            aria-pressed={adding?.kind === "middle"}
            onClick={() => setAdding(adding?.kind === "middle" ? null : { kind: "middle", index: value.middleAssetIds.length })}
          >
            <ImagePlusIcon />
            Add middle image
          </Button>
        </div>
        {value.middleAssetIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">None. Middle images guide what the characters do and look like partway through the clip.</p>
        ) : (
          <ol className="grid gap-2">
            {value.middleAssetIds.map((id, index) => {
              const candidate = byId.get(id);
              return (
                <li key={id}>
                  <FrameRow
                    number={2 + index}
                    title={`Middle image ${index + 1}`}
                    actions={
                      <>
                        <IconButton label="Move earlier" disabled={index === 0} onClick={() => move(index, -1)}>
                          <ArrowUpIcon />
                        </IconButton>
                        <IconButton label="Move later" disabled={index === value.middleAssetIds.length - 1} onClick={() => move(index, 1)}>
                          <ArrowDownIcon />
                        </IconButton>
                        <IconButton label="Remove" onClick={() => setMiddle(value.middleAssetIds.filter((x) => x !== id))}>
                          <XIcon />
                        </IconButton>
                      </>
                    }
                  >
                    {candidate ? <Thumb candidate={candidate} /> : <Missing />}
                  </FrameRow>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* End */}
      <FrameRow
        number={value.endAssetId ? endNumber : null}
        title="End image"
        hint={value.endAssetId ? undefined : "Optional. Without one, Kling decides how the clip ends."}
        actions={
          value.endAssetId ? (
            <IconButton label="Remove end image" onClick={() => onChange({ ...value, endAssetId: null })}>
              <XIcon />
            </IconButton>
          ) : (
            <Button type="button" size="sm" variant="outline" aria-pressed={adding?.kind === "end"} onClick={() => setAdding(adding?.kind === "end" ? null : { kind: "end" })}>
              <ImagePlusIcon />
              Choose end image
            </Button>
          )
        }
      >
        {value.endAssetId ? (byId.get(value.endAssetId) ? <Thumb candidate={byId.get(value.endAssetId)!} /> : <Missing />) : null}
      </FrameRow>

      {/* Chooser */}
      {adding && (
        <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium">
              Choose the {adding.kind === "end" ? "end image" : `middle image ${adding.index + 1}`}
            </p>
            <div className="flex items-center gap-2">
              <ImportAssetDialog
                target={{ sceneId }}
                origin="computer"
                label="Upload image"
                title="Upload a keyframe"
                description="A JPEG or PNG from your computer. It's added to this scene's assets as “Needs review” and appears under “This scene” here."
                variant="ghost"
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          </div>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No images in this story yet. Upload one or generate a keyframe first.</p>
          ) : (
            groups.map((group) => (
              <section key={group} className="grid gap-1.5">
                <h6 className="text-xs text-muted-foreground">{group}</h6>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {candidates
                    .filter((c) => c.group === group)
                    .map((c) => {
                      const taken = used.has(c.id);
                      const unsupported = !klingAccepts(c.contentType);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          disabled={taken || unsupported}
                          title={taken ? "Already used as a keyframe" : unsupported ? "Kling only accepts JPEG or PNG" : undefined}
                          onClick={() => pick(c.id)}
                          className={cn(
                            "grid content-start gap-1 rounded-md border p-1.5 text-left text-xs transition-colors",
                            taken || unsupported ? "opacity-40" : "hover:border-primary hover:bg-primary/10",
                          )}
                        >
                          <AssetPreview kind="image" filePath={c.filePath} sourceUrl={c.sourceUrl} controls={false} />
                          <span className="line-clamp-2">{c.label}</span>
                          {c.status !== "approved" && <AssetStatusBadge status={c.status} />}
                          {unsupported && <span className="text-amber-300">Not JPEG/PNG</span>}
                        </button>
                      );
                    })}
                </div>
              </section>
            ))
          )}
        </div>
      )}

      {/* Save */}
      <div className="grid gap-1 border-t pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || pending || Boolean(problem)} onClick={() => run(() => setSceneFrames(sceneId, value))}>
            <SaveIcon />
            {pending ? "Saving…" : "Save keyframes"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {total} of {KLING_MAX_IMAGES} images
          </span>
        </div>
        {problem && (
          <p className="flex items-start gap-2 text-xs text-rose-300">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {problem}
          </p>
        )}
        {dirty && !problem && <p className="text-xs text-amber-300">Unsaved changes. Save the keyframes before generating.</p>}
      </div>
    </div>
  );
}

function FrameRow({
  number,
  title,
  hint,
  actions,
  children,
}: {
  number: number | null;
  title: string;
  hint?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-md border bg-background/60 p-2">
      <div className="w-28 shrink-0">{children}</div>
      <div className="grid min-w-0 gap-0.5 text-xs">
        <p className="font-medium">
          {title}
          {number !== null && <span className="ml-1 font-mono text-muted-foreground">@image_{number}</span>}
        </p>
        {hint && <p className="text-muted-foreground">{hint}</p>}
      </div>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </div>
  );
}

function Thumb({ candidate }: { candidate: ReferenceCandidate }) {
  return (
    <div className="grid gap-1 text-xs">
      <AssetPreview kind="image" filePath={candidate.filePath} sourceUrl={candidate.sourceUrl} controls={false} />
      <span className="line-clamp-2 text-muted-foreground">{candidate.label}</span>
      {candidate.status !== "approved" && <AssetStatusBadge status={candidate.status} />}
      {!klingAccepts(candidate.contentType) && <span className="text-amber-300">Not JPEG/PNG</span>}
    </div>
  );
}

function Missing() {
  return <p className="text-xs text-rose-300">This image was rejected or deleted. Remove it.</p>;
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}
