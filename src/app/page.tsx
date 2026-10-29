import {
  ArrowRightIcon,
  BookOpenIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  type LucideIcon,
  LightbulbIcon,
  SearchCheckIcon,
  SendIcon,
  SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { NewIdeaButton } from "@/components/ideas/new-idea-button";
import { SampleDataButton } from "@/components/ideas/sample-data-button";
import { SampleBadge, StatusBadge } from "@/components/ideas/status-badge";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CATEGORY_LABELS,
  STAGE_GROUPS,
  STATUS_LABELS,
  type IdeaStatus,
} from "@/lib/ideas";
import { MODULES } from "@/lib/navigation";
import { getRecentIdeas, getStatusCounts } from "@/server/queries/ideas";
import { getStoriesInProgressCount } from "@/server/queries/stories";

const PIPELINE: { status: IdeaStatus; hint: string }[] = [
  { status: "draft", hint: "New ideas" },
  { status: "approved", hint: "Story in progress" },
  { status: "scripted", hint: "Ready to produce" },
  { status: "generated", hint: "Awaiting publish" },
  { status: "published", hint: "Live on YouTube" },
];

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function timeAgo(date: Date) {
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  return relativeTime.format(Math.round(hours / 24), "day");
}

function sum(counts: Record<IdeaStatus, number>, statuses: readonly IdeaStatus[]) {
  return statuses.reduce((total, s) => total + counts[s], 0);
}

export default function DashboardPage() {
  return (
    <div className="grid gap-6">
      <PageHeader title="Dashboard" description={MODULES.dashboard.description}>
        <NewIdeaButton />
      </PageHeader>

      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardData />
      </Suspense>
    </div>
  );
}

async function DashboardData() {
  await connection();
  const [counts, recent, storiesInProgress] = await Promise.all([
    getStatusCounts(),
    getRecentIdeas(6),
    getStoriesInProgressCount(),
  ]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pipelineMax = Math.max(1, ...PIPELINE.map((p) => counts[p.status]));

  const stats: { label: string; value: number; hint: string; icon: LucideIcon; href: string }[] = [
    {
      label: "Total ideas",
      value: total,
      hint: `${counts.archived} archived`,
      icon: LightbulbIcon,
      href: "/ideas",
    },
    {
      label: "Stories in progress",
      value: storiesInProgress,
      hint: "Drafts and stories in review",
      icon: BookOpenIcon,
      href: MODULES.stories.href,
    },
    {
      label: "Videos in production",
      value: sum(counts, STAGE_GROUPS.videosInProduction),
      hint: "Scripted or generated",
      icon: ClapperboardIcon,
      href: "/ideas?status=scripted",
    },
    {
      label: "Published videos",
      value: sum(counts, STAGE_GROUPS.published),
      hint: "Marked as published",
      icon: SendIcon,
      href: "/ideas?status=published",
    },
  ];

  return (
    <>
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key metrics">
        {stats.map(({ label, value, hint, icon: Icon, href }) => (
          <Link key={label} href={href} className="group">
            <Card className="h-full gap-2 py-4 transition-colors group-hover:border-primary/40">
              <CardContent className="grid gap-2 px-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">{label}</p>
                  <Icon className="size-4 text-primary/80" />
                </div>
                <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Production pipeline</CardTitle>
              <CardDescription>
                Ideas by workflow status. Approving a story in the Story Workshop moves its idea
                to Scripted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-2 sm:grid-cols-5 sm:gap-1">
                {PIPELINE.map(({ status, hint }, i) => (
                  <li key={status} className="flex items-stretch gap-1">
                    <Link
                      href={`/ideas?status=${status}`}
                      className="grid flex-1 content-start gap-1.5 rounded-lg border bg-background/40 p-3 transition-colors hover:border-primary/40"
                    >
                      <span className="text-xs font-medium">{STATUS_LABELS[status]}</span>
                      <span className="text-2xl font-semibold tabular-nums">{counts[status]}</span>
                      <span className="h-1 rounded-full bg-muted" role="presentation">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${(counts[status] / pipelineMax) * 100}%` }}
                        />
                      </span>
                      <span className="text-[11px] text-muted-foreground">{hint}</span>
                    </Link>
                    {i < PIPELINE.length - 1 && (
                      <ChevronRightIcon className="hidden size-3.5 shrink-0 self-center text-muted-foreground/50 sm:block" />
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent projects</CardTitle>
              <CardDescription>Latest activity across all ideas</CardDescription>
              <CardAction>
                <Link
                  href="/ideas"
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  View all <ArrowRightIcon className="size-3.5" />
                </Link>
              </CardAction>
            </CardHeader>
            <CardContent>
              {recent.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    Nothing here yet. Create your first idea or load sample data to explore.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <NewIdeaButton />
                    <SampleDataButton mode="load" />
                  </div>
                </div>
              ) : (
                <ul className="divide-y">
                  {recent.map((idea) => (
                    <li key={idea.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-medium">{idea.title}</p>
                          {idea.isSample && <SampleBadge />}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {CATEGORY_LABELS[idea.category]} · Updated {timeAgo(idea.updatedAt)}
                        </p>
                      </div>
                      <StatusBadge status={idea.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <QuickActions />
      </div>
    </>
  );
}

function QuickActions() {
  const actions: { href: string; label: string; text: string; icon: LucideIcon }[] = [
    {
      href: "/ideas?originality=not_reviewed",
      label: "Review originality",
      text: "Ideas not yet checked for originality",
      icon: SearchCheckIcon,
    },
    {
      href: "/ideas?priority=high",
      label: "High-priority ideas",
      text: "Focus on what matters most",
      icon: LightbulbIcon,
    },
    {
      href: MODULES.stories.href,
      label: "Story Workshop",
      text: "Draft scripts and storyboards with Claude",
      icon: BookOpenIcon,
    },
    {
      href: MODULES.production.href,
      label: "Production Studio",
      text: "Generate and review scene assets",
      icon: ClapperboardIcon,
    },
    {
      href: MODULES.settings.href,
      label: "Manage sample data",
      text: "Load or remove demo ideas",
      icon: SettingsIcon,
    },
  ];

  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>Quick actions</CardTitle>
        <CardDescription>Jump into common tasks</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <NewIdeaButton />
        {actions.map(({ href, label, text, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 rounded-lg border bg-background/40 px-3 py-2.5 transition-colors hover:border-primary/40"
          >
            <Icon className="size-4 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{text}</span>
            </span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid gap-6 lg:col-span-2">
          <Skeleton className="h-44 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </>
  );
}
