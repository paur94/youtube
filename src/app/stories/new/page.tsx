import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { StoryForm } from "@/components/stories/story-form";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { getIdeaOptions } from "@/server/queries/stories";

export const metadata: Metadata = { title: "New story" };

export default function NewStoryPage({ searchParams }: PageProps<"/stories/new">) {
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <Link
        href="/stories"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All stories
      </Link>
      <PageHeader
        title="New story"
        description="Write the brief. You'll generate and review the story on the next screen."
        icon={MODULES.stories.icon}
      />
      <Card>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-[36rem] rounded-lg" />}>
            <NewStoryForm searchParams={searchParams} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

async function NewStoryForm({ searchParams }: Pick<PageProps<"/stories/new">, "searchParams">) {
  await connection();
  const [ideas, params] = await Promise.all([getIdeaOptions(), searchParams]);
  const requested = Array.isArray(params.idea) ? params.idea[0] : params.idea;
  // Ignore unknown or archived ideas rather than failing.
  const initialIdeaId = ideas.some((i) => i.id === requested) ? requested : undefined;

  return <StoryForm ideas={ideas} initialIdeaId={initialIdeaId} />;
}
