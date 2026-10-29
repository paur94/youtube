import { ArrowLeftIcon, BookOpenIcon, ImageOffIcon, ImagesIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { AssetPreview } from "@/components/production/asset-preview";
import { PlanStatusBadge, SceneStatusBadge } from "@/components/production/badges";
import {
  AddSceneButton,
  AssemblyPanel,
  DeletePlanButton,
  JobPoller,
  PlanSettings,
  SceneOrderButtons,
} from "@/components/production/plan-actions";
import { ProgressBar, ProgressLegend } from "@/components/production/progress";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import {
  formatUsd,
  isReadyForAssembly,
  POLLABLE_JOB_STATUSES,
  summarizeCosts,
  summarizeProgress,
} from "@/lib/production";
import { formatDuration } from "@/lib/stories";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import { getPlan } from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.production.label };

export default function PlanPage({ params }: PageProps<"/production/[id]">) {
  return (
    <div className="grid gap-6">
      <Link
        href="/production"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All production plans
      </Link>
      <Suspense fallback={<PlanSkeleton />}>
        <PlanData params={params} />
      </Suspense>
    </div>
  );
}

function PlanSkeleton() {
  return (
    <>
      <Skeleton className="h-12 w-2/3 rounded-lg" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-[32rem] rounded-xl lg:col-span-2" />
        <div className="grid content-start gap-6">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    </>
  );
}

async function PlanData({ params }: Pick<PageProps<"/production/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const plan = await getPlan(id);
  if (!plan) notFound();

  const progress = summarizeProgress(plan.scenes);
  const costs = summarizeCosts(plan.jobs);
  const activeApiJobs = plan.jobs.filter((j) => j.mode === "api" && POLLABLE_JOB_STATUSES.includes(j.status)).length;
  const totalSeconds = plan.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const higgsfield = getHiggsfieldConfig();

  return (
    <>
      <PageHeader
        title={plan.title}
        description={`${plan.scenes.length} scenes · ${formatDuration(totalSeconds)}${plan.sourceRevision ? ` · imported from story revision ${plan.sourceRevision}` : ""}`}
        icon={MODULES.production.icon}
      >
        <PlanStatusBadge status={plan.status} />
        {plan.story && (
          <Button asChild variant="outline">
            <Link href={`/stories/${plan.story.id}`}>
              <BookOpenIcon />
              Story
            </Link>
          </Button>
        )}
        <Button asChild variant="outline">
          <Link href={`/production/assets?plan=${plan.id}`}>
            <ImagesIcon />
            Assets
          </Link>
        </Button>
        <DeletePlanButton planId={plan.id} title={plan.title} />
      </PageHeader>

      {plan.story && plan.story.status !== "approved" && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          The story was edited and is back in review in the Story Workshop. This plan keeps the scenes imported earlier;
          story edits are not synced automatically.
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="grid min-w-0 gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
              <CardDescription>
                <span className="text-foreground tabular-nums">
                  {progress.approved} of {progress.total}
                </span>{" "}
                scenes have an approved final asset ({progress.percent}%)
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ProgressBar progress={progress} />
              <ProgressLegend progress={progress} />
              <JobPoller planId={plan.id} active={higgsfield.configured ? activeApiJobs : 0} />
            </CardContent>
          </Card>

          <Card className="gap-0 overflow-hidden pb-0">
            <CardHeader className="pb-4">
              <CardTitle>Scenes</CardTitle>
              <CardDescription>Open a scene to edit it, generate assets and review them.</CardDescription>
              <CardAction>
                <AddSceneButton planId={plan.id} />
              </CardAction>
            </CardHeader>
            {plan.scenes.length === 0 ? (
              <p className="border-t px-6 py-10 text-center text-sm text-muted-foreground">
                No scenes. Add one to get started.
              </p>
            ) : (
              <ol className="divide-y border-t">
                {plan.scenes.map((scene, i) => (
                  <li key={scene.id} className="relative flex items-center gap-3 px-4 py-3 hover:bg-muted/30">
                    <SceneOrderButtons sceneId={scene.id} first={i === 0} last={i === plan.scenes.length - 1} />
                    <span className="w-6 shrink-0 text-center text-sm font-semibold text-muted-foreground tabular-nums">
                      {i + 1}
                    </span>
                    <div className="hidden w-28 shrink-0 sm:block">
                      {scene.selected ? (
                        <AssetPreview
                          kind={scene.selected.kind}
                          filePath={scene.selected.filePath}
                          sourceUrl={scene.selected.sourceUrl}
                          controls={false}
                        />
                      ) : (
                        <div className="flex aspect-video items-center justify-center rounded-md border border-dashed text-muted-foreground">
                          <ImageOffIcon className="size-4" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/production/${plan.id}/scenes/${scene.id}`}
                        className="font-medium after:absolute after:inset-0 hover:text-primary"
                      >
                        {scene.title}
                      </Link>
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {scene.durationSeconds}s
                        {scene.characterNames.length > 0 && ` · ${scene.characterNames.join(", ")}`}
                        {scene.narration && ` · ${scene.narration}`}
                      </p>
                      {scene.error && <p className="line-clamp-1 text-xs text-rose-300">{scene.error}</p>}
                    </div>
                    <SceneStatusBadge status={scene.status} />
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Final assembly</CardTitle>
            </CardHeader>
            <CardContent>
              <AssemblyPanel planId={plan.id} status={plan.status} ready={isReadyForAssembly(plan.scenes)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Generation costs</CardTitle>
              <CardDescription>Estimates from Higgsfield&apos;s estimate endpoint, before submission</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1.5 text-sm">
              {costs.estimatedUsd !== null ? (
                <p>
                  <span className="text-2xl font-semibold tabular-nums">{formatUsd(costs.estimatedUsd)}</span>{" "}
                  <span className="text-muted-foreground">
                    across {costs.estimatedJobs} API {costs.estimatedJobs === 1 ? "job" : "jobs"}
                  </span>
                </p>
              ) : (
                <p className="text-muted-foreground">No pricing information yet.</p>
              )}
              {costs.unpricedJobs > 0 && (
                <p className="text-xs text-muted-foreground">
                  {costs.unpricedJobs} API {costs.unpricedJobs === 1 ? "job has" : "jobs have"} no estimate.
                </p>
              )}
              {costs.manualJobs > 0 && (
                <p className="text-xs text-muted-foreground">
                  {costs.manualJobs} manual {costs.manualJobs === 1 ? "job uses" : "jobs use"} your Higgsfield web plan
                  credits, which aren&apos;t tracked here.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Failed and moderated requests aren&apos;t charged. Your actual bill is in the Higgsfield console.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Production settings</CardTitle>
            </CardHeader>
            <CardContent>
              <PlanSettings
                planId={plan.id}
                settings={{
                  aspectRatio: plan.aspectRatio,
                  imageModel: plan.imageModel,
                  videoModel: plan.videoModel,
                  visualStyle: plan.visualStyle,
                }}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
