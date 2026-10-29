import { BookOpenIcon, ClapperboardIcon, ImagesIcon, KeyRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { PlanStatusBadge } from "@/components/production/badges";
import { NewPlanButton } from "@/components/production/plan-actions";
import { ProgressBar } from "@/components/production/progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { summarizeProgress } from "@/lib/production";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import {
  getStoriesAwaitingApprovalCount,
  getStoriesReadyForProduction,
  listPlans,
} from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.production.label };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export default function ProductionPage() {
  return (
    <div className="grid gap-6">
      <Suspense
        fallback={
          <>
            <PageHeader title={MODULES.production.label} description={MODULES.production.description} icon={MODULES.production.icon} />
            <div className="grid gap-6 lg:grid-cols-3">
              <Skeleton className="h-72 rounded-xl lg:col-span-2" />
              <Skeleton className="h-48 rounded-xl" />
            </div>
          </>
        }
      >
        <ProductionData />
      </Suspense>
    </div>
  );
}

async function ProductionData() {
  await connection();
  const [plans, readyStories, awaitingApproval] = await Promise.all([
    listPlans(),
    getStoriesReadyForProduction(),
    getStoriesAwaitingApprovalCount(),
  ]);
  const higgsfield = getHiggsfieldConfig();

  return (
    <>
      <PageHeader title={MODULES.production.label} description={MODULES.production.description} icon={MODULES.production.icon}>
        <Button asChild variant="outline">
          <Link href="/production/assets">
            <ImagesIcon />
            Asset library
          </Link>
        </Button>
        <NewPlanButton
          stories={readyStories.map((s) => ({ id: s.id, title: s.generatedTitle ?? s.title, sceneCount: s.sceneCount }))}
        />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          {plans.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                  <ClapperboardIcon className="size-5 text-primary" />
                </div>
                <p className="font-medium">No production plans yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {readyStories.length > 0
                    ? `${readyStories.length} approved ${readyStories.length === 1 ? "story is" : "stories are"} ready. Choose New production plan to import the scenes.`
                    : awaitingApproval > 0
                      ? `${awaitingApproval} ${awaitingApproval === 1 ? "story is" : "stories are"} waiting for approval. Approve one in the Story Workshop to start production.`
                      : "Write and approve a story in the Story Workshop first."}
                </p>
                <Button asChild variant="outline">
                  <Link href="/stories">
                    <BookOpenIcon />
                    Go to Story Workshop
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            plans.map((plan) => {
              const progress = summarizeProgress(plan.scenes);
              return (
                <Link key={plan.id} href={`/production/${plan.id}`} className="group">
                  <Card className="gap-3 py-4 transition-colors group-hover:border-primary/40">
                    <CardContent className="grid gap-3 px-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium">{plan.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {plan.storyId ? "From an approved story" : "Story deleted"} · Updated{" "}
                            {dateFormat.format(plan.updatedAt)}
                          </p>
                        </div>
                        <PlanStatusBadge status={plan.status} />
                      </div>
                      <ProgressBar progress={progress} />
                      <p className="text-xs text-muted-foreground">
                        <span className="text-foreground tabular-nums">
                          {progress.approved}/{progress.total}
                        </span>{" "}
                        scenes approved ({progress.percent}%)
                        {progress.counts.review > 0 && ` · ${progress.counts.review} need review`}
                        {progress.counts.generating > 0 && ` · ${progress.counts.generating} generating`}
                        {progress.counts.failed > 0 && ` · ${progress.counts.failed} failed`}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Higgsfield</CardTitle>
              <CardDescription>
                {higgsfield.configured ? "API connected · automated generation available" : "API not configured · manual workflow"}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm text-muted-foreground">
              {higgsfield.configured ? (
                <p>
                  Jobs are submitted from each scene page and polled while the page is open. Every result needs your
                  review before it can be used.
                </p>
              ) : (
                <div className="flex items-start gap-2">
                  <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                  <p>
                    Add <code className="rounded bg-muted px-1">HF_API_KEY_ID</code> and{" "}
                    <code className="rounded bg-muted px-1">HF_API_KEY_SECRET</code> to{" "}
                    <code className="rounded bg-muted px-1">.env.local</code> to enable automated generation. Meanwhile,
                    copy prompts into the Higgsfield web app and import the results.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid list-decimal gap-1.5 pl-4 text-sm text-muted-foreground">
                <li>Approve a story in the Story Workshop.</li>
                <li>Create a plan. Scenes, narration and characters are imported.</li>
                <li>Edit, reorder and link characters to each scene.</li>
                <li>Generate keyframes and clips (API or manual).</li>
                <li>Review every asset and pick a final one per scene.</li>
                <li>Mark the plan ready for assembly. Nothing is published.</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
