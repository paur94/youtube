"use client";

import { BotIcon, ExternalLinkIcon, HandIcon, HardDriveUploadIcon, KeyRoundIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  describeDurations,
  getHiggsfieldModel,
  HIGGSFIELD_MODELS,
  HIGGSFIELD_WEB_URL,
  modelDuration,
} from "@/lib/higgsfield";
import type { AssetKind } from "@/lib/production";
import { generateScene, startManualJob } from "@/server/actions/production";

import { CopyButton } from "./copy-button";
import { HedraPanel } from "./hedra-panel";
import { ImportAssetDialog } from "./import-asset-dialog";
import { useAction } from "./use-action";

type StartImage = { id: string; label: string };

// Long model names shrink to the column and truncate instead of overlapping the next field.
const TRIGGER = "w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate";

export function GenerationPanel({
  sceneId,
  durationSeconds,
  defaults,
  apiConfigured,
  replicateConfigured,
  hedraConfigured,
  prompt,
  negativePrompt,
  concerns,
  startImages,
  characterReferences,
  sceneReferenceCount,
  openManualJobs,
}: {
  sceneId: string;
  durationSeconds: number;
  defaults: { imageModel: string; videoModel: string };
  apiConfigured: boolean;
  /** Replicate serves the Wan 3.0 models marked provider "replicate". */
  replicateConfigured: boolean;
  hedraConfigured: boolean;
  /** Full prompt including character descriptions and style. */
  prompt: string;
  negativePrompt: string;
  concerns: string[];
  startImages: StartImage[];
  /** Linked characters and whether each has an approved reference image. */
  characterReferences: { name: string; hasReference: boolean }[];
  /** Extra images picked under "Reference images" for this scene. */
  sceneReferenceCount: number;
  openManualJobs: { id: string; outputKind: AssetKind; label: string }[];
}) {
  const available = HIGGSFIELD_MODELS.filter((m) => (m.provider === "replicate" ? replicateConfigured : apiConfigured));
  // The plan default may belong to a provider that isn't configured; fall back to the first available model.
  const defaultFor = (k: AssetKind) => {
    const wanted = k === "image" ? defaults.imageModel : defaults.videoModel;
    return available.some((m) => m.id === wanted) ? wanted : (available.find((m) => m.output === k)?.id ?? wanted);
  };
  const [kind, setKind] = useState<AssetKind>("image");
  const [modelId, setModelId] = useState(() => defaultFor("image"));
  const [startAssetId, setStartAssetId] = useState(startImages[0]?.id ?? "");
  const [numImages, setNumImages] = useState("2");
  const [pending, run] = useAction();
  const id = useId();

  const model = getHiggsfieldModel(modelId);
  const providerName = model?.provider === "replicate" ? "Replicate" : "Higgsfield";
  const needsStart = model?.input === "image";
  const blocked = concerns.length > 0 || !prompt.trim();

  function switchKind(next: AssetKind) {
    setKind(next);
    setModelId(defaultFor(next));
  }

  return (
    <div className="grid gap-6">
      {/* Automated */}
      <section className="grid gap-3 rounded-lg border border-primary/30 p-4">
        <header className="flex items-center gap-2">
          <BotIcon className="size-4 text-primary" />
          <h3 className="font-medium">Automated: {apiConfigured && replicateConfigured ? "Higgsfield & Replicate APIs" : replicateConfigured ? "Replicate API" : "Higgsfield API"}</h3>
        </header>
        {!apiConfigured && !replicateConfigured ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
            <p>
              Not configured. Add <code className="rounded bg-muted px-1">HF_API_KEY_ID</code> and{" "}
              <code className="rounded bg-muted px-1">HF_API_KEY_SECRET</code> from{" "}
              <a href="https://console.higgsfield.ai" target="_blank" rel="noreferrer" className="underline">
                console.higgsfield.ai
              </a>{" "}
              to <code className="rounded bg-muted px-1">.env.local</code> and restart. API usage is billed
              separately from a Higgsfield web subscription. For Wan 3.0 on Replicate, add{" "}
              <code className="rounded bg-muted px-1">REPLICATE_API_TOKEN</code> instead. Until then, use the manual
              workflow below.
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm" role="tablist">
              {(["image", "video"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => switchKind(k)}
                  className="flex-1 rounded-md px-2 py-1 aria-selected:bg-background aria-selected:shadow-sm"
                >
                  {k === "image" ? "Keyframe image" : "Video clip"}
                </button>
              ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor={`${id}-model`}>Model</Label>
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger id={`${id}-model`} className={TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {available.filter((m) => m.output === kind).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {model?.maxImages && (
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor={`${id}-count`}>Variations</Label>
                  <Select value={numImages} onValueChange={setNumImages}>
                    <SelectTrigger id={`${id}-count`} className={TRIGGER}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: model.maxImages }, (_, i) => String(i + 1)).map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {needsStart && (
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor={`${id}-start`}>Start image</Label>
                  {startImages.length ? (
                    <Select value={startAssetId} onValueChange={setStartAssetId}>
                      <SelectTrigger id={`${id}-start`} className={TRIGGER}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {startImages.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Approve a keyframe image for this scene (or a character reference) first.
                    </p>
                  )}
                </div>
              )}
            </div>
            {model?.maxReferenceImages && (characterReferences.length > 0 || sceneReferenceCount > 0) && (
              <ReferenceNote characters={characterReferences} sceneReferences={sceneReferenceCount} />
            )}
            {model?.output === "video" && (
              <p className="text-xs text-muted-foreground">
                Scene is {durationSeconds}s. This model makes {describeDurations(model)} clips, so it will request{" "}
                {modelDuration(model, durationSeconds)}s.
                {!model.supportsNegativePrompt && " The negative prompt isn't supported by this model."}
              </p>
            )}
            {blocked && (
              <p className="flex items-start gap-2 text-xs text-rose-300">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                {prompt.trim() ? "Fix the prompt issues above first." : "Add a visual prompt first."}
              </p>
            )}
            <Button
              className="w-fit"
              disabled={pending || blocked || (needsStart && !startAssetId)}
              onClick={() =>
                run(() =>
                  generateScene(sceneId, {
                    modelId,
                    startAssetId: needsStart ? startAssetId : null,
                    numImages: model?.maxImages ? Number(numImages) : undefined,
                  }),
                )
              }
            >
              <SparklesIcon />
              {pending ? "Submitting…" : `Generate with ${providerName}`}
            </Button>
            <p className="text-xs text-muted-foreground">
              {model?.provider === "replicate"
                ? "Bills your Replicate account per second of video; the estimate on the job uses Replicate's published price."
                : "Uses your Higgsfield API balance. A cost estimate is requested first and shown on the job when Higgsfield returns one."}{" "}
              Results always need your review.
            </p>
          </>
        )}
      </section>

      <HedraPanel sceneId={sceneId} configured={hedraConfigured} startImages={startImages} blocked={blocked} />

      {/* Manual */}
      <section className="grid gap-3 rounded-lg border border-amber-500/30 p-4">
        <header className="flex items-center gap-2">
          <HandIcon className="size-4 text-amber-400" />
          <h3 className="font-medium">Manual: Higgsfield web app</h3>
        </header>
        <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
          <li>Copy the prompt (and negative prompt if the tool has a field for it).</li>
          <li>
            Generate in Higgsfield. Upload approved character reference images there if you use a character or
            reference feature.
          </li>
          <li>Download the result and import it here. It&apos;s marked “Needs review”.</li>
        </ol>
        <div className="grid gap-2">
          <pre className="max-h-48 overflow-auto rounded-md border bg-background/60 p-3 text-xs whitespace-pre-wrap">
            {prompt || "No prompt yet"}
          </pre>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={prompt} label="Copy prompt" />
            <CopyButton text={negativePrompt} label="Copy negative prompt" />
            <Button asChild variant="outline" size="sm">
              <a href={HIGGSFIELD_WEB_URL} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open Higgsfield
              </a>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {openManualJobs.length === 0 ? (
            <ManualStartButtons sceneId={sceneId} />
          ) : (
            openManualJobs.map((job) => (
              <ImportAssetDialog
                key={job.id}
                target={{ sceneId }}
                jobId={job.id}
                variant="default"
                label={`Import ${job.outputKind} for ${job.label}`}
              />
            ))
          )}
          <ImportAssetDialog target={{ sceneId }} label="Import without a job" variant="ghost" />
        </div>
      </section>

      {/* Upload */}
      <section className="grid gap-3 rounded-lg border p-4">
        <header className="flex items-center gap-2">
          <HardDriveUploadIcon className="size-4 text-muted-foreground" />
          <h3 className="font-medium">Upload from computer</h3>
        </header>
        <p className="text-sm text-muted-foreground">
          Add an image or clip you made with another tool or already have on disk. It&apos;s copied into the media
          folder and marked “Needs review” like any other result.
        </p>
        <ImportAssetDialog
          target={{ sceneId }}
          origin="computer"
          label="Upload file"
          title="Upload a scene asset"
          description="Choose an image or video from your computer. It's copied into the local media folder and marked “Needs review”."
        />
      </section>
    </div>
  );
}

function ReferenceNote({
  characters,
  sceneReferences,
}: {
  characters: { name: string; hasReference: boolean }[];
  sceneReferences: number;
}) {
  const withRef = characters.filter((c) => c.hasReference).map((c) => c.name);
  const missing = characters.filter((c) => !c.hasReference).map((c) => c.name);
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      {withRef.length > 0 && <p>Sends reference images for {withRef.join(", ")} to keep them consistent.</p>}
      {sceneReferences > 0 && (
        <p>
          Also sends {sceneReferences} scene reference image{sceneReferences === 1 ? "" : "s"} picked below.
        </p>
      )}
      {missing.length > 0 && (
        <p className="flex items-start gap-2 text-amber-300">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            No approved reference for {missing.join(", ")}, so they&apos;ll be drawn from the text description and may
            look different in each scene. Upload and approve one on the{" "}
            <Link href="/characters" className="underline">
              Characters
            </Link>{" "}
            page.
          </span>
        </p>
      )}
    </div>
  );
}

function ManualStartButtons({ sceneId }: { sceneId: string }) {
  const [pending, run] = useAction();
  return (
    <>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => startManualJob(sceneId, "image"))}>
        Start manual image job
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => startManualJob(sceneId, "video"))}>
        Start manual video job
      </Button>
    </>
  );
}
