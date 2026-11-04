import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { ideas, stories } from "@/db/schema";
import { IDEA_STATUSES, type IdeaStatus } from "@/lib/ideas";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Moves the idea behind a story forward to `to` (scripted → generated → published), so the idea
 * list and dashboard follow the pipeline without manual status changes. Never moves an idea
 * backwards and never touches archived ones.
 */
export async function advanceIdeaStatus(storyId: string | null | undefined, to: IdeaStatus, tx: Tx | typeof db = db) {
  if (!storyId) return false;
  const earlier = IDEA_STATUSES.slice(0, IDEA_STATUSES.indexOf(to)).filter((s) => s !== "archived");
  if (!earlier.length) return false;
  const [story] = await tx.select({ ideaId: stories.ideaId }).from(stories).where(eq(stories.id, storyId));
  if (!story?.ideaId) return false;
  const moved = await tx
    .update(ideas)
    .set({ status: to })
    .where(and(eq(ideas.id, story.ideaId), inArray(ideas.status, earlier)))
    .returning({ id: ideas.id });
  return moved.length > 0;
}

/** Best effort: the upload already succeeded, so a failure here must not be reported as a failed publish. */
export async function markIdeaPublished(storyId: string | null | undefined) {
  try {
    await advanceIdeaStatus(storyId, "published");
  } catch (error) {
    console.error("markIdeaPublished failed", error);
  }
}
