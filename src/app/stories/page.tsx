import { BookOpenIcon, KeyRoundIcon, LightbulbIcon, PlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { StoryStatusBadge } from "@/components/stories/story-status-badge";
import { UsageStats } from "@/components/stories/usage-summary";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AGE_GROUP_LABELS } from "@/lib/ideas";
import { MODULES } from "@/lib/navigation";
import { formatDuration } from "@/lib/stories";
import { getClaudeConfig } from "@/server/ai/claude";
import { getWorkspaceUsage, listStories } from "@/server/queries/stories";

export const metadata: Metadata = { title: MODULES.stories.label };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export default function StoriesPage() {
  return (
    <div className="grid gap-6">
      <PageHeader
        title={MODULES.stories.label}
        description="Turn ideas into age-appropriate scripts and storyboards with Claude, then review and approve them."
        icon={MODULES.stories.icon}
      >
        <NewStoryButton />
      </PageHeader>

      <Suspense fallback={<StoriesSkeleton />}>
        <StoriesData />
      </Suspense>
    </div>
  );
}

function NewStoryButton() {
  return (
    <Button asChild>
      <Link href="/stories/new">
        <PlusIcon />
        New story
      </Link>
    </Button>
  );
}

function StoriesSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Skeleton className="h-80 rounded-xl lg:col-span-2" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

async function StoriesData() {
  await connection();
  const [stories, usage] = await Promise.all([listStories(), getWorkspaceUsage()]);
  const claude = getClaudeConfig();

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="gap-0 self-start overflow-hidden py-0 lg:col-span-2">
        {stories.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <BookOpenIcon className="size-5 text-primary" />
            </div>
            <p className="font-medium">No stories yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Start a story from scratch, or pick an idea from Idea Discovery and choose{" "}
              <span className="font-medium text-foreground">Start story</span> in its menu.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <NewStoryButton />
              <Button asChild variant="outline">
                <Link href="/ideas">
                  <LightbulbIcon />
                  Browse ideas
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Story</TableHead>
                <TableHead className="hidden md:table-cell">Age</TableHead>
                <TableHead className="hidden sm:table-cell">Length</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden pr-4 lg:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stories.map((story) => (
                <TableRow key={story.id} className="relative">
                  <TableCell className="max-w-sm min-w-48 pl-4 whitespace-normal">
                    <Link href={`/stories/${story.id}`} className="font-medium after:absolute after:inset-0 hover:text-primary">
                      {story.generatedTitle ?? story.title}
                    </Link>
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {story.generatedTitle && story.generatedTitle !== story.title && `Working title: ${story.title} · `}
                      {story.ideaTitle ? `From idea: ${story.ideaTitle}` : "From scratch"} · {story.language}
                    </p>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {AGE_GROUP_LABELS[story.ageGroup]}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDuration(story.targetDurationSeconds)}
                  </TableCell>
                  <TableCell>
                    <StoryStatusBadge status={story.status} />
                  </TableCell>
                  <TableCell className="hidden pr-4 text-muted-foreground lg:table-cell">
                    {dateFormat.format(story.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Claude API</CardTitle>
            <CardDescription>
              {claude.configured
                ? `Connected · ${claude.model} · effort ${claude.effort}`
                : "Not configured"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {claude.configured ? (
              <UsageStats usage={usage} />
            ) : (
              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <p>
                  Add <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY</code> to{" "}
                  <code className="rounded bg-muted px-1">.env.local</code> and restart the dev
                  server to enable generation. You can still create and edit briefs.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
