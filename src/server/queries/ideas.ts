import "server-only";

import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { ideas } from "@/db/schema";
import { IDEA_STATUSES, type IdeaFilters, type IdeaStatus } from "@/lib/ideas";

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listIdeas(filters: IdeaFilters = {}) {
  const conditions: (SQL | undefined)[] = [
    filters.status && eq(ideas.status, filters.status),
    filters.category && eq(ideas.category, filters.category),
    filters.ageGroup && eq(ideas.ageGroup, filters.ageGroup),
    filters.priority && eq(ideas.priority, filters.priority),
    filters.originality && eq(ideas.originalityStatus, filters.originality),
  ];

  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      or(
        ilike(ideas.title, pattern),
        ilike(ideas.description, pattern),
        sql`array_to_string(${ideas.tags}, ' ') ilike ${pattern}`,
      ),
    );
  }

  return db
    .select()
    .from(ideas)
    .where(and(...conditions))
    .orderBy(desc(ideas.createdAt));
}

export async function getRecentIdeas(limit = 5) {
  return db.select().from(ideas).orderBy(desc(ideas.updatedAt)).limit(limit);
}

export async function getStatusCounts() {
  const rows = await db
    .select({ status: ideas.status, count: count() })
    .from(ideas)
    .groupBy(ideas.status);

  const counts = Object.fromEntries(IDEA_STATUSES.map((s) => [s, 0])) as Record<IdeaStatus, number>;
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

export async function getSampleIdeaCount() {
  const [row] = await db.select({ count: count() }).from(ideas).where(eq(ideas.isSample, true));
  return row?.count ?? 0;
}
