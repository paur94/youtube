import "server-only";

import { count, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { ideas, stories, storyGenerations, storyRevisions } from "@/db/schema";
import { summarizeUsage } from "@/lib/ai-usage";

export async function listStories() {
  return db
    .select({
      id: stories.id,
      title: stories.title,
      generatedTitle: sql<string | null>`${stories.content}->>'title'`,
      ageGroup: stories.ageGroup,
      targetDurationSeconds: stories.targetDurationSeconds,
      language: stories.language,
      status: stories.status,
      updatedAt: stories.updatedAt,
      ideaId: stories.ideaId,
      ideaTitle: ideas.title,
    })
    .from(stories)
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .orderBy(desc(stories.updatedAt));
}

export async function getStory(id: string) {
  const [row] = await db
    .select({ story: stories, ideaTitle: ideas.title })
    .from(stories)
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .where(eq(stories.id, id));
  return row ? { ...row.story, ideaTitle: row.ideaTitle } : null;
}

export async function getStoryRevisions(storyId: string) {
  return db
    .select({
      id: storyRevisions.id,
      number: storyRevisions.number,
      source: storyRevisions.source,
      instructions: storyRevisions.instructions,
      createdAt: storyRevisions.createdAt,
      title: sql<string>`${storyRevisions.content}->>'title'`,
      model: storyGenerations.model,
    })
    .from(storyRevisions)
    .leftJoin(storyGenerations, eq(storyRevisions.generationId, storyGenerations.id))
    .where(eq(storyRevisions.storyId, storyId))
    .orderBy(desc(storyRevisions.number));
}

export async function getStoryGenerations(storyId: string) {
  return db
    .select()
    .from(storyGenerations)
    .where(eq(storyGenerations.storyId, storyId))
    .orderBy(desc(storyGenerations.createdAt));
}

export async function getWorkspaceUsage() {
  const rows = await db
    .select({
      model: storyGenerations.model,
      inputTokens: storyGenerations.inputTokens,
      outputTokens: storyGenerations.outputTokens,
      cacheReadTokens: storyGenerations.cacheReadTokens,
      cacheWriteTokens: storyGenerations.cacheWriteTokens,
    })
    .from(storyGenerations);
  return summarizeUsage(rows);
}

/** Ideas that can seed a new story (everything except archived). */
export async function getIdeaOptions() {
  return db
    .select({
      id: ideas.id,
      title: ideas.title,
      description: ideas.description,
      ageGroup: ideas.ageGroup,
      format: ideas.format,
      notes: ideas.notes,
    })
    .from(ideas)
    .where(ne(ideas.status, "archived"))
    .orderBy(desc(ideas.updatedAt));
}

export type IdeaOption = Awaited<ReturnType<typeof getIdeaOptions>>[number];

export async function getStoriesInProgressCount() {
  const [row] = await db
    .select({ count: count() })
    .from(stories)
    .where(inArray(stories.status, ["draft", "review"]));
  return row?.count ?? 0;
}
