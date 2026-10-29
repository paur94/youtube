import { ExternalLinkIcon, LightbulbIcon, SearchXIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { IdeaFilterBar } from "@/components/ideas/idea-filters";
import { IdeaRowActions } from "@/components/ideas/idea-row-actions";
import { NewIdeaButton } from "@/components/ideas/new-idea-button";
import { SampleDataButton } from "@/components/ideas/sample-data-button";
import { OriginalityBadge, SampleBadge, StatusBadge } from "@/components/ideas/status-badge";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AGE_GROUP_LABELS,
  CATEGORY_LABELS,
  IDEA_STATUSES,
  ideasHref,
  parseIdeaFilters,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type IdeaFilters,
} from "@/lib/ideas";
import { MODULES } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { getStatusCounts, listIdeas } from "@/server/queries/ideas";

export const metadata: Metadata = { title: MODULES.ideas.label };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export default function IdeasPage({ searchParams }: PageProps<"/ideas">) {
  return (
    <div className="grid gap-6">
      <PageHeader
        title={MODULES.ideas.label}
        description="Every video starts here. Review originality and move ideas through the pipeline."
        icon={MODULES.ideas.icon}
      >
        <NewIdeaButton />
      </PageHeader>

      <Suspense fallback={<IdeasSkeleton />}>
        <IdeasData searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function IdeasSkeleton() {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-72" />
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-40" />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: IDEA_STATUSES.length + 1 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <Skeleton className="h-96 rounded-xl" />
    </>
  );
}

async function IdeasData({ searchParams }: Pick<PageProps<"/ideas">, "searchParams">) {
  await connection();
  const filters = parseIdeaFilters(await searchParams);

  const [ideas, counts] = await Promise.all([listIdeas(filters), getStatusCounts()]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <>
      <div className="grid gap-3">
        <IdeaFilterBar filters={filters} />
        <nav className="flex flex-wrap gap-2" aria-label="Filter by workflow status">
          <FilterChip
            href={ideasHref({ ...filters, status: undefined })}
            active={!filters.status}
            label="All"
            count={total}
          />
          {IDEA_STATUSES.map((s) => (
            <FilterChip
              key={s}
              href={ideasHref({ ...filters, status: s })}
              active={filters.status === s}
              label={STATUS_LABELS[s]}
              count={counts[s]}
            />
          ))}
        </nav>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        {total === 0 ? (
          <NoIdeasState />
        ) : ideas.length === 0 ? (
          <NoMatchesState filters={filters} />
        ) : (
          <>
            <IdeasTable ideas={ideas} />
            <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
              {filtered ? `${ideas.length} of ${total} ideas match` : `${total} ideas`}
            </p>
          </>
        )}
      </Card>
    </>
  );
}

function IdeasTable({ ideas }: { ideas: Awaited<ReturnType<typeof listIdeas>> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Idea</TableHead>
          <TableHead className="hidden lg:table-cell">Category</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Originality</TableHead>
          <TableHead className="hidden xl:table-cell">Age</TableHead>
          <TableHead className="hidden sm:table-cell">Priority</TableHead>
          <TableHead className="hidden xl:table-cell">Created</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {ideas.map((idea) => (
          <TableRow key={idea.id}>
            <TableCell className="max-w-sm min-w-56 pl-4 whitespace-normal">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{idea.title}</span>
                {idea.isSample && <SampleBadge />}
              </div>
              {idea.description && (
                <p className="line-clamp-1 text-xs text-muted-foreground">{idea.description}</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {idea.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="h-4 px-1.5 text-[10px]">
                    {tag}
                  </Badge>
                ))}
                {idea.sourceUrl && (
                  <a
                    href={idea.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-primary"
                  >
                    <ExternalLinkIcon className="size-3" />
                    Source
                  </a>
                )}
              </div>
            </TableCell>
            <TableCell className="hidden text-muted-foreground lg:table-cell">
              {CATEGORY_LABELS[idea.category]}
            </TableCell>
            <TableCell>
              <StatusBadge status={idea.status} />
            </TableCell>
            <TableCell className="hidden md:table-cell">
              <OriginalityBadge status={idea.originalityStatus} />
            </TableCell>
            <TableCell className="hidden text-muted-foreground xl:table-cell">
              {AGE_GROUP_LABELS[idea.ageGroup]}
            </TableCell>
            <TableCell className="hidden sm:table-cell">
              <span className={cn(idea.priority === "high" && "font-medium text-rose-300")}>
                {PRIORITY_LABELS[idea.priority]}
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground xl:table-cell">
              {dateFormat.format(idea.createdAt)}
            </TableCell>
            <TableCell className="pr-4 text-right">
              <IdeaRowActions idea={idea} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FilterChip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("text-xs tabular-nums", active ? "opacity-80" : "opacity-60")}>
        {count}
      </span>
    </Link>
  );
}

function NoIdeasState() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <LightbulbIcon className="size-5 text-primary" />
      </div>
      <p className="font-medium">No ideas yet</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Capture your first video concept (a song, a story, a counting game), or load sample ideas
        to explore the workflow.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <NewIdeaButton />
        <SampleDataButton mode="load" />
      </div>
    </div>
  );
}

function NoMatchesState({ filters }: { filters: IdeaFilters }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <SearchXIcon className="size-5 text-muted-foreground" />
      </div>
      <p className="font-medium">No ideas match these filters</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {filters.q ? `Nothing found for “${filters.q}”. ` : ""}Try a different search or clear the
        filters.
      </p>
      <Button asChild variant="outline">
        <Link href="/ideas" scroll={false}>
          Clear filters
        </Link>
      </Button>
    </div>
  );
}
