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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { buildGenerationPrompt, findPromptConcerns, POLLABLE_JOB_STATUSES } from "@/lib/production";
import { getHedraConfig } from "@/server/providers/hedra";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import { getCharacterOptions, getScene } from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.production.label };

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
  const [detail, characterOptions] = await Promise.all([getScene(sceneId), getCharacterOptions()]);
  if (!detail || detail.plan.id !== id) notFound();

  const { scene, plan } = detail;
  const higgsfield = getHiggsfieldConfig();
  const linked = characterOptions.filter((c) => detail.characterIds.includes(c.id));
  const prompt = buildGenerationPrompt({ visualPrompt: scene.visualPrompt, characters: linked, visualStyle: plan.visualStyle });
  const concerns = findPromptConcerns(prompt);
  const revisions = new Map(detail.assets.map((a) => [a.id, a.revision]));
  const activeApiJobs = detail.jobs.filter((j) => j.mode === "api" && POLLABLE_JOB_STATUSES.includes(j.status)).length;

  const startImages = [
    ...detail.assets
      .filter((a) => a.kind === "image" && a.status === "approved")
      .map((a) => ({ id: a.id, label: `Scene keyframe r${a.revision}` })),
    ...detail.references.map((r) => ({ id: r.id, label: `${r.characterName} reference` })),
  ];
  const characterReferences = linked.map((c) => ({
    name: c.name,
    hasReference: detail.references.some((r) => r.characterId === c.id),
  }));
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
                apiConfigured={higgsfield.configured}
                hedraConfigured={getHedraConfig().configured}
                prompt={prompt}
                negativePrompt={scene.negativePrompt}
                concerns={concerns}
                startImages={startImages}
                openManualJobs={openManualJobs}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Generation history</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <JobPoller sceneId={scene.id} active={higgsfield.configured ? activeApiJobs : 0} />
              <JobList jobs={detail.jobs.map(toJobItem)} />
            </CardContent>
          </Card>
        </div>
      </div>

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
                  asset={toAssetItem(asset, (assetId) => revisions.get(assetId))}
                  isFinal={scene.selectedAssetId === asset.id}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
