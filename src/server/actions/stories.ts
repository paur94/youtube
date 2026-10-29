"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/db";
import { ideas, stories, storyGenerations, storyRevisions } from "@/db/schema";
import {
  parseStoryContentJson,
  parseStoryForm,
  type RevisionSource,
  type StoryContent,
  type StoryFormState,
} from "@/lib/stories";
import {
  getClaudeClient,
  getClaudeConfig,
  NOT_CONFIGURED_MESSAGE,
  runStoryGeneration,
} from "@/server/ai/claude";
import { buildStoryPrompt } from "@/server/ai/story-prompt";
import { getStory } from "@/server/queries/stories";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.

const idSchema = z.uuid();
const notesSchema = z.string().trim().max(2000, "Revision notes are limited to 2000 characters");

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function revalidateStory(id?: string) {
  revalidatePath("/");
  revalidatePath("/stories");
  if (id) revalidatePath(`/stories/${id}`);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Every content change is a new revision; the story row mirrors the latest one and goes back
// to review, so an edited story always needs to be approved again.
async function addRevision(
  tx: Tx,
  storyId: string,
  revision: {
    source: RevisionSource;
    content: StoryContent;
    generationId?: string;
    instructions?: string | null;
  },
) {
  const [{ next }] = await tx
    .select({ next: sql`coalesce(max(${storyRevisions.number}), 0) + 1`.mapWith(Number) })
    .from(storyRevisions)
    .where(eq(storyRevisions.storyId, storyId));
  await tx.insert(storyRevisions).values({ storyId, number: next, ...revision });
  await tx
    .update(stories)
    .set({ content: revision.content, status: "review", approvedAt: null })
    .where(eq(stories.id, storyId));
  return next;
}

export async function createStory(_prev: StoryFormState, formData: FormData): Promise<StoryFormState> {
  const parsed = parseStoryForm(formData);
  if (!parsed.success) {
    return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  }

  let id: string;
  try {
    [{ id }] = await db.insert(stories).values(parsed.data).returning({ id: stories.id });
  } catch (error) {
    console.error("createStory failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateStory();
  redirect(`/stories/${id}`);
}

export async function updateStoryBrief(
  id: string,
  _prev: StoryFormState,
  formData: FormData,
): Promise<StoryFormState> {
  const storyId = idSchema.safeParse(id);
  const parsed = parseStoryForm(formData);
  if (!storyId.success) return { ok: false, message: "Invalid story id" };
  if (!parsed.success) {
    return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  }

  let updated: { id: string }[];
  try {
    updated = await db
      .update(stories)
      .set(parsed.data)
      .where(eq(stories.id, storyId.data))
      .returning({ id: stories.id });
  } catch (error) {
    console.error("updateStoryBrief failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (updated.length === 0) return { ok: false, message: "Story not found" };

  revalidateStory(storyId.data);
  return { ok: true, message: "Brief updated. Regenerate to apply it to the story." };
}

export async function deleteStory(id: string): Promise<ActionResult> {
  const storyId = idSchema.safeParse(id);
  if (!storyId.success) return { ok: false, message: "Invalid story id" };

  try {
    await db.delete(stories).where(eq(stories.id, storyId.data));
  } catch (error) {
    console.error("deleteStory failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateStory();
  return { ok: true, message: "Story deleted" };
}

export async function generateStory(id: string, notes = ""): Promise<ActionResult> {
  const storyId = idSchema.safeParse(id);
  const revisionNotes = notesSchema.safeParse(notes);
  if (!storyId.success) return { ok: false, message: "Invalid story id" };
  if (!revisionNotes.success) return { ok: false, message: revisionNotes.error.issues[0].message };

  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  let story: Awaited<ReturnType<typeof getStory>>;
  try {
    story = await getStory(storyId.data);
  } catch (error) {
    console.error("generateStory: load failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!story) return { ok: false, message: "Story not found" };

  const { model, effort } = getClaudeConfig();
  const prompt = buildStoryPrompt(story, { previous: story.content, notes: revisionNotes.data });
  const result = await runStoryGeneration(client, { model, effort, ...prompt });

  let revisionNumber: number | null;
  try {
    revisionNumber = await db.transaction(async (tx) => {
      const [generation] = await tx
        .insert(storyGenerations)
        .values({
          storyId: story.id,
          ok: result.ok,
          model: result.model,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          cacheReadTokens: result.usage?.cacheReadTokens,
          cacheWriteTokens: result.usage?.cacheWriteTokens,
          durationMs: result.durationMs,
          error: result.ok ? null : result.message,
        })
        .returning({ id: storyGenerations.id });

      if (!result.ok) return null;
      return addRevision(tx, story.id, {
        source: story.content ? "regenerated" : "generated",
        content: result.content,
        generationId: generation.id,
        instructions: revisionNotes.data || null,
      });
    });
  } catch (error) {
    console.error("generateStory: save failed", error);
    return {
      ok: false,
      message: result.ok ? `The story was generated but could not be saved. ${DB_ERROR}` : DB_ERROR,
    };
  }

  revalidateStory(story.id);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: `Revision ${revisionNumber} is ready for review` };
}

export async function saveStoryEdits(id: string, contentJson: string): Promise<ActionResult> {
  const storyId = idSchema.safeParse(id);
  if (!storyId.success) return { ok: false, message: "Invalid story id" };
  const parsed = parseStoryContentJson(contentJson);
  if (!parsed.success) return { ok: false, message: parsed.message };

  let revisionNumber: number | null;
  try {
    revisionNumber = await db.transaction(async (tx) => {
      const [story] = await tx
        .select({ id: stories.id })
        .from(stories)
        .where(eq(stories.id, storyId.data))
        .for("update");
      if (!story) return null;
      return addRevision(tx, storyId.data, { source: "edited", content: parsed.data });
    });
  } catch (error) {
    console.error("saveStoryEdits failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (revisionNumber === null) return { ok: false, message: "Story not found" };

  revalidateStory(storyId.data);
  return { ok: true, message: `Saved as revision ${revisionNumber}` };
}

export async function restoreRevision(id: string, revisionId: string): Promise<ActionResult> {
  const storyId = idSchema.safeParse(id);
  const revId = idSchema.safeParse(revisionId);
  if (!storyId.success || !revId.success) return { ok: false, message: "Invalid revision" };

  let restored: { from: number; to: number } | null;
  try {
    restored = await db.transaction(async (tx) => {
      const [revision] = await tx
        .select({ number: storyRevisions.number, content: storyRevisions.content })
        .from(storyRevisions)
        .where(and(eq(storyRevisions.id, revId.data), eq(storyRevisions.storyId, storyId.data)));
      if (!revision) return null;
      const to = await addRevision(tx, storyId.data, {
        source: "restored",
        content: revision.content,
        instructions: `Restored from revision ${revision.number}`,
      });
      return { from: revision.number, to };
    });
  } catch (error) {
    console.error("restoreRevision failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!restored) return { ok: false, message: "Revision not found" };

  const { from, to } = restored;
  revalidateStory(storyId.data);
  return { ok: true, message: `Revision ${from} restored as revision ${to}` };
}

// Approval is a manual step and never publishes anything; it marks the story ready for the
// Production Studio and moves a linked idea forward to "scripted".
export async function setStoryApproval(id: string, approved: boolean): Promise<ActionResult> {
  const storyId = idSchema.safeParse(id);
  if (!storyId.success) return { ok: false, message: "Invalid story id" };

  let outcome: ActionResult;
  try {
    outcome = await db.transaction(async (tx) => {
      const [story] = await tx
        .select({ status: stories.status, hasContent: sql<boolean>`${stories.content} is not null`, ideaId: stories.ideaId })
        .from(stories)
        .where(eq(stories.id, storyId.data))
        .for("update");
      if (!story) return { ok: false, message: "Story not found" };

      if (!approved) {
        await tx.update(stories).set({ status: "review", approvedAt: null }).where(eq(stories.id, storyId.data));
        return { ok: true, message: "Story moved back to review" };
      }

      if (!story.hasContent) return { ok: false, message: "Generate the story before approving it" };
      await tx
        .update(stories)
        .set({ status: "approved", approvedAt: new Date() })
        .where(eq(stories.id, storyId.data));

      if (story.ideaId) {
        const moved = await tx
          .update(ideas)
          .set({ status: "scripted" })
          .where(and(eq(ideas.id, story.ideaId), inArray(ideas.status, ["draft", "approved"])))
          .returning({ id: ideas.id });
        if (moved.length > 0) {
          return { ok: true, message: "Approved for production. The linked idea is now Scripted." };
        }
      }
      return { ok: true, message: "Approved for production" };
    });
  } catch (error) {
    console.error("setStoryApproval failed", error);
    return { ok: false, message: DB_ERROR };
  }

  revalidateStory(storyId.data);
  revalidatePath("/ideas");
  return outcome;
}
