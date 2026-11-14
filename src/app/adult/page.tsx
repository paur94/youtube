import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { AdultLab } from "@/components/lab/adult-lab";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { db } from "@/db";
import { labJobs, labProjects } from "@/db/schema";
import { MODULES } from "@/lib/navigation";

export const metadata: Metadata = { title: MODULES.adult.label };

export default function AdultLabPage({ searchParams }: PageProps<"/adult">) {
  return (
    <div className="grid gap-6">
      <PageHeader title={MODULES.adult.label} description={MODULES.adult.description} icon={MODULES.adult.icon} />
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <LabData searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function LabData({ searchParams }: Pick<PageProps<"/adult">, "searchParams">) {
  await connection();
  const { project: wanted } = await searchParams;
  const projects = await db
    .select({ id: labProjects.id, topic: labProjects.topic, createdAt: labProjects.createdAt })
    .from(labProjects)
    .orderBy(desc(labProjects.createdAt))
    .limit(50);

  // "new" opens the empty form; otherwise the requested project, or the latest one.
  const selectedId = wanted === "new" ? null : (projects.find((p) => p.id === wanted) ?? projects[0])?.id ?? null;
  const [project] = selectedId ? await db.select().from(labProjects).where(eq(labProjects.id, selectedId)) : [];
  const jobs = project
    ? await db.select().from(labJobs).where(eq(labJobs.projectId, project.id)).orderBy(desc(labJobs.createdAt))
    : [];

  return <AdultLab projects={projects} project={project ?? null} jobs={jobs} />;
}
