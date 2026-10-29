import { ArrowLeftIcon, ClapperboardIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import {
  ApprovalPanel,
  DeleteStoryButton,
  EditBriefButton,
  RevisionList,
} from "@/components/stories/story-actions";
import { StoryStatusBadge } from "@/components/stories/story-status-badge";
import { StoryWorkspace } from "@/components/stories/story-workspace";
import { GenerationLog, UsageStats } from "@/components/stories/usage-summary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { summarizeUsage } from "@/lib/ai-usage";
import { AGE_GROUP_LABELS } from "@/lib/ideas";
import { MODULES } from "@/lib/navigation";
import { formatDuration } from "@/lib/stories";
import { getClaudeConfig } from "@/server/ai/claude";
import { getPlanIdForStory } from "@/server/queries/production";
import {
  getIdeaOptions,
  getStory,
  getStoryGenerations,
  getStoryRevisions,
} from "@/server/queries/stories";

export const metadata: Metadata = { title: MODULES.stories.label };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export default function StoryPage({ params }: PageProps<"/stories/[id]">) {
  return (
    <div className="grid gap-6">
      <Link
        href="/stories"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All stories
      </Link>
      <Suspense fallback={<StorySkeleton />}>
        <StoryData params={params} />
      </Suspense>
    </div>
  );
}

function StorySkeleton() {
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

async function StoryData({ params }: Pick<PageProps<"/stories/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const story = await getStory(id);
  if (!story) notFound();

  const [revisions, generations, ideas, planId] = await Promise.all([
    getStoryRevisions(id),
    getStoryGenerations(id),
    getIdeaOptions(),
    getPlanIdForStory(id),
  ]);
  const claude = getClaudeConfig();
  const usage = summarizeUsage(generations);

  const brief: [string, string][] = [
    ["Source idea", story.ideaTitle ?? "Started from scratch"],
    ["Age range", AGE_GROUP_LABELS[story.ageGroup]],
    ["Duration", formatDuration(story.targetDurationSeconds)],
    ["Language", story.language],
    ["Tone", story.tone],
    ["Visual style", story.visualStyle],
    ["Topic", story.topic],
    ["Learning objective", story.learningObjective],
    ["Characters", story.characters || "Claude invents them"],
  ];
  if (story.notes) brief.push(["Notes", story.notes]);

  return (
    <>
      <PageHeader
        title={story.content?.title ?? story.title}
        description={story.content ? `Working title: ${story.title}` : "Brief ready. Generate the story below."}
        icon={MODULES.stories.icon}
      >
        <StoryStatusBadge status={story.status} />
        {(planId || story.status === "approved") && (
          <Button asChild variant="outline">
            <Link href={planId ? `/production/${planId}` : "/production"}>
              <ClapperboardIcon />
              {planId ? "Production plan" : "Start production"}
            </Link>
          </Button>
        )}
        <EditBriefButton story={story} ideas={ideas} />
        <DeleteStoryButton storyId={story.id} title={story.content?.title ?? story.title} />
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <StoryWorkspace
            storyId={story.id}
            content={story.content}
            latestRevision={revisions[0]?.number ?? null}
            targetDurationSeconds={story.targetDurationSeconds}
            claude={{ configured: claude.configured, model: claude.model }}
          />
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Production approval</CardTitle>
            </CardHeader>
            <CardContent>
              <ApprovalPanel
                storyId={story.id}
                status={story.status}
                hasContent={story.content !== null}
                approvedAt={story.approvedAt ? dateTimeFormat.format(story.approvedAt) : null}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Brief</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-2.5 text-sm">
                {brief.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-line">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Revision history</CardTitle>
              <CardDescription>Restoring copies an old revision into a new one.</CardDescription>
            </CardHeader>
            <CardContent>
              <RevisionList
                storyId={story.id}
                revisions={revisions.map((r) => ({ ...r, createdAt: dateTimeFormat.format(r.createdAt) }))}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>API usage</CardTitle>
              <CardDescription>Every Claude call for this story, including failed ones</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <UsageStats usage={usage} />
              <GenerationLog generations={generations} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
