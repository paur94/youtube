import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, ImagesIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { AssetCard } from "@/components/production/asset-card";
import { SceneStatusBadge } from "@/components/production/badges";
import { toAssetItem, toJobItem } from "@/components/production/format";
import { GenerationPanel } from "@/components/production/generation-panel";
import { JobList } from "@/components/production/job-list";
import { DeleteSceneButton, JobPoller } from "@/components/production/plan-actions";
import { SceneForm } from "@/components/production/scene-form";
import { SceneReferencePicker } from "@/components/qc/qc-actions";
import { SceneQcCard } from "@/components/qc/scene-qc-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { HIGGSFIELD_MODELS } from "@/lib/higgsfield";
import { readSceneFrames } from "@/lib/kling";
import { MODULES } from "@/lib/navigation";
import { readOverlays } from "@/lib/overlays";
import { buildGenerationPrompt, buildVideoPrompt, findPromptConcerns, POLLABLE_JOB_STATUSES } from "@/lib/production";
import { formatDialogue } from "@/lib/stories";
import { getClaudeConfig } from "@/server/ai/claude";
import { loadClipMusic } from "@/server/production/service";
import { getHedraConfig } from "@/server/providers/hedra";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import { getReplicateConfig } from "@/server/providers/replicate";
import { generationBlockers, getReferenceCandidates, loadSceneQc } from "@/server/qc/service";
import { getCharacterOptions, getScene } from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.production.label };

const MAX_REFERENCE_IMAGES = Math.max(0, ...HIGGSFIELD_MODELS.map((m) => m.maxReferenceImages ?? 0));

type Props = PageProps<"/production/[id]/scenes/[sceneId]">;

export default function ScenePage({ params }: Props) {
  return (
    <div className="grid gap-6">
      <Suspense fallback={<SceneSkeleton />}>
        <SceneData params={params} />
      </Suspense>
    </div>
  );
}

function SceneSkeleton() {
  return (
    <>
      <Skeleton className="h-5 w-40 rounded" />
      <Skeleton className="h-12 w-2/3 rounded-lg" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-144 rounded-xl" />
        <Skeleton className="h-144 rounded-xl" />
      </div>
    </>
  );
}

function SceneNavButton({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) {
    return (
      <Button variant="ghost" size="sm" disabled>
        {children}
      </Button>
    );
  }
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={href}>{children}</Link>
    </Button>
  );
}

async function SceneData({ params }: Pick<Props, "params">) {
  await connection();
  const { id, sceneId } = await params;
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(sceneId).success) notFound();
  const [detail, characterOptions, qc] = await Promise.all([getScene(sceneId), getCharacterOptions(), loadSceneQc(sceneId)]);
  if (!detail || detail.plan.id !== id || !qc) notFound();
  const referenceCandidates = await getReferenceCandidates({
    planId: id,
    sceneId,
    storyId: detail.plan.storyId,
    characterIds: detail.characterIds,
  });
  const claude = getClaudeConfig();
  const qcBlockers = generationBlockers(qc.current).map((i) => `Story QC: ${i.message}`);
  const assetQc = { specHash: qc.current.state.specHash, dismissed: qc.current.continuity.dismissed };

  const { scene, plan } = detail;
  const higgsfield = getHiggsfieldConfig();
  const linked = characterOptions.filter((c) => detail.characterIds.includes(c.id));
  const prompt = buildGenerationPrompt({ visualPrompt: scene.visualPrompt, characters: linked, visualStyle: plan.visualStyle });
  const music = await loadClipMusic(plan, scene);
  // Clips are prompted from the action and dialogue (no voice-over); the exact text depends on whether the
  // model animates a start image. Shown in the panel so what is sent can be checked before generating.
  const videoPromptFor = (startImage: boolean) =>
    buildVideoPrompt({
      visualPrompt: scene.visualPrompt,
      action: scene.action,
      setting: scene.setting,
      dialogue: scene.dialogue,
      characters: linked,
      visualStyle: plan.visualStyle,
      durationSeconds: scene.durationSeconds,
      startImage,
      voiced: true,
      music,
    });
  const videoPrompts = { fromImage: videoPromptFor(true), fromText: videoPromptFor(false) };
  // The sent prompts also carry character descriptions, the plan style, action and dialogue, so a concern
  // may not be in the visual prompt at all. Each is labelled with the field to edit.
  const sources: [string, string][] = [
    ["Visual prompt", scene.visualPrompt],
    ...linked.map((c): [string, string] => [`Character “${c.name}” (Characters page)`, `${c.name} ${c.visualDescription}`]),
    ["Plan visual style", plan.visualStyle ?? ""],
    ["Action", scene.action],
    ["Dialogue", formatDialogue(scene.dialogue)],
  ];
  const sourcedConcerns = sources.flatMap(([where, text]) => findPromptConcerns(text).map((c) => `${where}: ${c}`));
  const builtConcerns = [
    ...new Set([...findPromptConcerns(prompt), ...findPromptConcerns(videoPrompts.fromImage), ...findPromptConcerns(videoPrompts.fromText)]),
  ];
  const concerns = [
    ...(sourcedConcerns.length || !builtConcerns.length ? sourcedConcerns : builtConcerns.map((c) => `Generated prompt: ${c}`)),
    ...qcBlockers,
  ];
  const revisions = new Map(detail.assets.map((a) => [a.id, a.revision]));
  const overlays = readOverlays(scene.overlays);
  const activeApiJobs = detail.jobs.filter((j) => j.mode === "api" && POLLABLE_JOB_STATUSES.includes(j.status)).length;

  const characterReferences = linked.map((c) => ({
    name: c.name,
    hasReference: detail.references.some((r) => r.characterId === c.id),
  }));
  const sceneReferenceIds = qc.current.continuity.referenceAssetIds.filter((refId) => referenceCandidates.some((c) => c.id === refId));
  // The previous scene's last frame comes first, so it's the default start and the cut is seamless.
  const lastFrameOf = (a: (typeof detail.assets)[number]) => a.metadata?.lastFrameOfScene;
  const startImages = [
    ...detail.assets
      .filter((a) => a.kind === "image" && a.status === "approved")
      .sort((a, b) => Number(lastFrameOf(b) !== undefined) - Number(lastFrameOf(a) !== undefined))
      .map((a) => ({
        id: a.id,
        label: lastFrameOf(a) !== undefined ? `Last frame of scene ${lastFrameOf(a)} r${a.revision}` : `Scene keyframe r${a.revision}`,
        keyframe: lastFrameOf(a) === undefined,
        contentType: a.contentType,
      })),
    ...detail.references.map((r) => ({ id: r.id, label: `${r.characterName} reference`, contentType: r.contentType })),
  ];
  // Picked scene references can be start frames too, even while still awaiting review.
  for (const ref of referenceCandidates.filter((c) => sceneReferenceIds.includes(c.id))) {
    if (startImages.some((s) => s.id === ref.id)) continue;
    const name = ref.group === "This scene" ? `this scene ${ref.label}` : ref.label;
    startImages.push({ id: ref.id, label: `Reference: ${name}${ref.status === "approved" ? "" : " (needs review)"}`, contentType: ref.contentType });
  }
  // Saved as is: a keyframe rejected or deleted since is shown as missing so it can be removed and re-saved.
  const frames = readSceneFrames(qc.current.continuity);
  const openManualJobs = detail.jobs
    .filter((j) => j.mode === "manual" && j.status === "awaiting_manual")
    .map((j) => ({ id: j.id, outputKind: j.outputKind, label: `job from ${toJobItem(j).createdAt}` }));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link
          href={`/production/${plan.id}`}
          className="inline-flex w-fit items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          {plan.title}
        </Link>
        <div className="flex items-center gap-1">
          <SceneNavButton href={detail.previousId && `/production/${plan.id}/scenes/${detail.previousId}`}>
            <ChevronLeftIcon />
            Previous
          </SceneNavButton>
          <SceneNavButton href={detail.nextId && `/production/${plan.id}/scenes/${detail.nextId}`}>
            Next
            <ChevronRightIcon />
          </SceneNavButton>
        </div>
      </div>

      <PageHeader
        title={`Scene ${detail.number}: ${scene.title}`}
        description={`${detail.number} of ${detail.total} · ${scene.durationSeconds}s`}
        icon={MODULES.production.icon}
      >
        <SceneStatusBadge status={scene.status} />
        <DeleteSceneButton sceneId={scene.id} planId={plan.id} title={scene.title} />
      </PageHeader>

      {scene.error && (
        <p className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {scene.error} Retry the job below, adjust the prompt, or import a manual result.
        </p>
      )}
      {scene.unmatchedCharacters.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Story characters not in the library: {scene.unmatchedCharacters.join(", ")}. Add them on the{" "}
          <Link href="/characters" className="underline">
            Characters
          </Link>{" "}
          page if they should stay consistent.
        </p>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Scene details</CardTitle>
            <CardDescription>Edits apply to new generations. Existing assets keep the prompt they were made with.</CardDescription>
          </CardHeader>
          <CardContent>
            <SceneForm scene={scene} characters={characterOptions} linkedIds={detail.characterIds} />
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Generate</CardTitle>
              <CardDescription>
                Automated and manual generation are kept separate, and every result needs your review.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <GenerationPanel
                sceneId={scene.id}
                durationSeconds={scene.durationSeconds}
                defaults={{ imageModel: plan.imageModel, videoModel: plan.videoModel }}
                characterReferences={characterReferences}
                sceneReferenceCount={sceneReferenceIds.length}
                frames={frames}
                frameCandidates={referenceCandidates}
                apiConfigured={higgsfield.configured}
                replicateConfigured={getReplicateConfig().configured}
                hedraConfigured={getHedraConfig().configured}
                prompt={prompt}
                videoPrompts={videoPrompts}
                negativePrompt={scene.negativePrompt}
                concerns={concerns}
                startImages={startImages}
                openManualJobs={openManualJobs}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reference images</CardTitle>
              <CardDescription>
                Pick images from anywhere in this story (a place, a prop, a keyframe you liked) to keep this scene
                consistent with them. Images awaiting review can be used; rejected ones can&apos;t.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SceneReferencePicker
                key={qc.current.continuity.referenceAssetIds.join()}
                sceneId={scene.id}
                candidates={referenceCandidates}
                selected={qc.current.continuity.referenceAssetIds}
                maxReferenceImages={MAX_REFERENCE_IMAGES}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Generation history</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <JobPoller sceneId={scene.id} active={higgsfield.configured || getReplicateConfig().configured ? activeApiJobs : 0} />
              <JobList jobs={detail.jobs.map(toJobItem)} />
            </CardContent>
          </Card>
        </div>
      </div>

      <SceneQcCard qc={qc.current} />

      <Card>
        <CardHeader>
          <CardTitle>Assets</CardTitle>
          <CardDescription>
            All revisions are kept. Approve an asset after reviewing it, then choose it as the scene&apos;s final asset.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {detail.assets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
              <ImagesIcon className="size-5" />
              No assets yet. Generate with the API or import a manual result.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {detail.assets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={toAssetItem(asset, (assetId) => revisions.get(assetId), assetQc)}
                  isFinal={scene.selectedAssetId === asset.id}
                  canInspect={claude.configured}
                  overlays={overlays}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
