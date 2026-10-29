"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { ideas } from "@/db/schema";
import { IDEA_STATUSES, parseIdeaForm, type IdeaFormState } from "@/lib/ideas";
import { SAMPLE_IDEAS } from "@/lib/sample-ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.

const idSchema = z.uuid();

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function revalidateIdeas() {
  revalidatePath("/");
  revalidatePath("/ideas");
  revalidatePath("/settings");
}

export async function createIdea(_prev: IdeaFormState, formData: FormData): Promise<IdeaFormState> {
  const parsed = parseIdeaForm(formData);
  if (!parsed.success) {
    return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  }

  try {
    await db.insert(ideas).values(parsed.data);
  } catch (error) {
    console.error("createIdea failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateIdeas();
  return { ok: true, message: "Idea created" };
}

export async function updateIdea(
  id: string,
  _prev: IdeaFormState,
  formData: FormData,
): Promise<IdeaFormState> {
  const ideaId = idSchema.safeParse(id);
  const parsed = parseIdeaForm(formData);
  if (!ideaId.success) return { ok: false, message: "Invalid idea id" };
  if (!parsed.success) {
    return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  }

  let updated: { id: string }[];
  try {
    updated = await db
      .update(ideas)
      .set(parsed.data)
      .where(eq(ideas.id, ideaId.data))
      .returning({ id: ideas.id });
  } catch (error) {
    console.error("updateIdea failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (updated.length === 0) return { ok: false, message: "Idea not found" };

  revalidateIdeas();
  return { ok: true, message: "Idea updated" };
}

export async function setIdeaStatus(id: string, status: string) {
  const ideaId = idSchema.parse(id);
  const nextStatus = z.enum(IDEA_STATUSES).parse(status);

  await db.update(ideas).set({ status: nextStatus }).where(eq(ideas.id, ideaId));
  revalidateIdeas();
}

export async function deleteIdea(id: string) {
  const ideaId = idSchema.parse(id);

  await db.delete(ideas).where(eq(ideas.id, ideaId));
  revalidateIdeas();
}

export async function loadSampleIdeas(): Promise<ActionResult> {
  try {
    const existing = await db.$count(ideas, eq(ideas.isSample, true));
    if (existing > 0) return { ok: false, message: "Sample ideas are already loaded" };

    // Stagger timestamps so the lists have a natural order.
    const now = Date.now();
    await db.insert(ideas).values(
      SAMPLE_IDEAS.map((idea, i) => {
        const at = new Date(now - i * 7 * 3_600_000);
        return { ...idea, isSample: true, createdAt: at, updatedAt: at };
      }),
    );
  } catch (error) {
    console.error("loadSampleIdeas failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateIdeas();
  return { ok: true, message: `Loaded ${SAMPLE_IDEAS.length} sample ideas` };
}

export async function removeSampleIdeas(): Promise<ActionResult> {
  let removed: { id: string }[];
  try {
    removed = await db
      .delete(ideas)
      .where(eq(ideas.isSample, true))
      .returning({ id: ideas.id });
  } catch (error) {
    console.error("removeSampleIdeas failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateIdeas();
  return { ok: true, message: `Removed ${removed.length} sample ideas` };
}
