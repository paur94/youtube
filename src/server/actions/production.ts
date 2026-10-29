"use server";

import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/db";
import {
  assets,
  characters,
  generationJobs,
  productionPlans,
  productionScenes,
  sceneCharacters,
  stories,
  storyCharacters,
  storyRevisions,
} from "@/db/schema";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, getHiggsfieldModel } from "@/lib/higgsfield";
import {
  ASPECT_RATIOS,
  ASSET_KINDS,
  buildGenerationPrompt,
  isReadyForAssembly,
  moveInOrder,
  normalizeName,
  parseSceneForm,
  type SceneFormState,
  scenesFromStory,
} from "@/lib/production";
import { downloadMedia, MediaError } from "@/server/media/storage";
import { getHiggsfieldClient } from "@/server/providers/higgsfield";
import {
  addAsset,
  refreshActiveJobs,
  refreshApiJob,
  retryApiJob,
  submitApiGeneration,
  syncSceneStatus,
} from "@/server/production/service";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.

const idSchema = z.uuid();

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function revalidateProduction(planId?: string, sceneId?: string) {
  revalidatePath("/");
  revalidatePath("/production");
  revalidatePath("/production/assets");
  revalidatePath("/characters");
  if (planId) revalidatePath(`/production/${planId}`);
  if (planId && sceneId) revalidatePath(`/production/${planId}/scenes/${sceneId}`);
}

async function planIdOfScene(sceneId: string) {
  const [row] = await db
    .select({ planId: productionScenes.planId })
    .from(productionScenes)
    .where(eq(productionScenes.id, sceneId));
  return row?.planId ?? null;
}

// ---------- Plans ----------

/** Imports an approved story's scenes, narration, characters and prompts into a new plan. */
export async function createProductionPlan(storyId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(storyId);
  if (!id.success) return { ok: false, message: "Invalid story id" };

  let outcome: { ok: false; message: string } | { ok: true; planId: string };
  try {
    outcome = await db.transaction(async (tx) => {
      const [story] = await tx.select().from(stories).where(eq(stories.id, id.data)).for("update");
      if (!story) return { ok: false, message: "Story not found" };
      if (story.status !== "approved" || !story.content) {
        return { ok: false, message: "Only stories approved in the Story Workshop can go into production" };
      }
      const [existing] = await tx
        .select({ id: productionPlans.id })
        .from(productionPlans)
        .where(eq(productionPlans.storyId, story.id));
      if (existing) return { ok: true, planId: existing.id };

      const [{ revision }] = await tx
        .select({ revision: sql<number | null>`max(${storyRevisions.number})` })
        .from(storyRevisions)
        .where(eq(storyRevisions.storyId, story.id));
      const [plan] = await tx
        .insert(productionPlans)
        .values({
          storyId: story.id,
          title: story.content.title.trim() || story.title,
          visualStyle: story.visualStyle,
          imageModel: DEFAULT_IMAGE_MODEL,
          videoModel: DEFAULT_VIDEO_MODEL,
          sourceRevision: revision === null ? null : Number(revision),
        })
        .returning({ id: productionPlans.id });

      const byName = await linkStoryCharacters(tx, story.id, story.title, story.content.characters);
      const drafts = scenesFromStory(story.content);
      for (const [position, draft] of drafts.entries()) {
        const matched = draft.characterNames.flatMap((n) => byName.get(normalizeName(n)) ?? []);
        const [scene] = await tx
          .insert(productionScenes)
          .values({
            planId: plan.id,
            position,
            title: draft.title,
            setting: draft.setting,
            action: draft.action,
            narration: draft.narration,
            dialogue: draft.dialogue,
            durationSeconds: draft.durationSeconds,
            visualPrompt: draft.visualPrompt,
            negativePrompt: draft.negativePrompt,
            unmatchedCharacters: draft.characterNames.filter((n) => !byName.has(normalizeName(n))),
            status: draft.visualPrompt.trim() ? "ready" : "draft",
          })
          .returning({ id: productionScenes.id });
        if (matched.length) {
          await tx
            .insert(sceneCharacters)
            .values([...new Set(matched)].map((characterId) => ({ sceneId: scene.id, characterId })));
        }
      }
      return { ok: true, planId: plan.id };
    });
  } catch (error) {
    console.error("createProductionPlan failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!outcome.ok) return outcome;
  revalidateProduction(outcome.planId);
  redirect(`/production/${outcome.planId}`);
}

// Reuses library characters with the same name (so approved looks carry across episodes) and
// adds the rest as drafts.
async function linkStoryCharacters(
  tx: Tx,
  storyId: string,
  storyTitle: string,
  storyCharactersList: { name: string; role: string; description: string; visualDescription: string }[],
) {
  const library = await tx
    .select({ id: characters.id, name: characters.name, status: characters.status })
    .from(characters)
    .where(ne(characters.status, "archived"))
    .orderBy(asc(characters.status)); // "approved" sorts before "draft"
  const byName = new Map<string, string>();
  for (const c of library) if (!byName.has(normalizeName(c.name))) byName.set(normalizeName(c.name), c.id);

  for (const c of storyCharactersList) {
    const key = normalizeName(c.name);
    if (!key) continue;
    let characterId = byName.get(key);
    if (!characterId) {
      [{ id: characterId }] = await tx
        .insert(characters)
        .values({
          name: c.name.trim(),
          role: c.role,
          description: c.description,
          visualDescription: c.visualDescription || c.description || c.name,
          notes: `Imported from the story “${storyTitle}”.`,
        })
        .returning({ id: characters.id });
      byName.set(key, characterId);
    }
    await tx.insert(storyCharacters).values({ storyId, characterId }).onConflictDoNothing();
  }
  return byName;
}

export async function deleteProductionPlan(planId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  try {
    await db.delete(productionPlans).where(eq(productionPlans.id, id.data));
  } catch (error) {
    console.error("deleteProductionPlan failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateProduction();
  return { ok: true, message: "Production plan deleted. Files stay in the media folder." };
}

const planSettingsSchema = z.object({
  aspectRatio: z.enum(ASPECT_RATIOS),
  imageModel: z.string().refine((m) => getHiggsfieldModel(m)?.output === "image", "Choose an image model"),
  videoModel: z.string().refine((m) => getHiggsfieldModel(m)?.output === "video", "Choose a video model"),
  visualStyle: z.string().trim().max(300),
});

export async function updatePlanSettings(
  planId: string,
  settings: Record<keyof z.input<typeof planSettingsSchema>, string>,
): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  const parsed = planSettingsSchema.safeParse(settings);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  try {
    await db.update(productionPlans).set(parsed.data).where(eq(productionPlans.id, id.data));
  } catch (error) {
    console.error("updatePlanSettings failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateProduction(id.data);
  return { ok: true, message: "Production settings saved" };
}

// Final assembly needs a reviewed, approved asset for every scene. Nothing is rendered or
// published by this step.
export async function setPlanReady(planId: string, ready: boolean): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  try {
    const scenes = await db
      .select({ status: productionScenes.status })
      .from(productionScenes)
      .where(eq(productionScenes.planId, id.data));
    if (ready && !isReadyForAssembly(scenes)) {
      const pending = scenes.filter((s) => s.status !== "approved").length;
      return {
        ok: false,
        message: scenes.length
          ? `${pending} of ${scenes.length} scenes still need an approved final asset`
          : "Add scenes first",
      };
    }
    await db
      .update(productionPlans)
      .set({ status: ready ? "ready_for_assembly" : "in_production" })
      .where(eq(productionPlans.id, id.data));
  } catch (error) {
    console.error("setPlanReady failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateProduction(id.data);
  return { ok: true, message: ready ? "Marked ready for assembly. Nothing was published." : "Moved back to production" };
}

// ---------- Scenes ----------

export async function updateScene(sceneId: string, _prev: SceneFormState, formData: FormData): Promise<SceneFormState> {
  const id = idSchema.safeParse(sceneId);
  const parsed = parseSceneForm(formData);
  if (!id.success) return { ok: false, message: "Invalid scene id" };
  if (!parsed.success) return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };

  const { characterIds, ...values } = parsed.data;
  let planId: string | null;
  try {
    planId = await db.transaction(async (tx) => {
      const [scene] = await tx
        .update(productionScenes)
        .set(values)
        .where(eq(productionScenes.id, id.data))
        .returning({ planId: productionScenes.planId });
      if (!scene) return null;
      await tx.delete(sceneCharacters).where(eq(sceneCharacters.sceneId, id.data));
      if (characterIds.length) {
        await tx
          .insert(sceneCharacters)
          .values([...new Set(characterIds)].map((characterId) => ({ sceneId: id.data, characterId })));
      }
      await syncSceneStatus(tx, id.data);
      return scene.planId;
    });
  } catch (error) {
    console.error("updateScene failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!planId) return { ok: false, message: "Scene not found" };
  revalidateProduction(planId, id.data);
  return { ok: true, message: "Scene saved" };
}

export async function addScene(planId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  let sceneId: string;
  try {
    [{ id: sceneId }] = await db.transaction(async (tx) => {
      const [{ next }] = await tx
        .select({ next: sql`coalesce(max(${productionScenes.position}), -1) + 1`.mapWith(Number) })
        .from(productionScenes)
        .where(eq(productionScenes.planId, id.data));
      return tx
        .insert(productionScenes)
        .values({ planId: id.data, position: next, title: "New scene", durationSeconds: 5, status: "draft" })
        .returning({ id: productionScenes.id });
    });
  } catch (error) {
    console.error("addScene failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateProduction(id.data);
  redirect(`/production/${id.data}/scenes/${sceneId}`);
}

export async function deleteScene(sceneId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  if (!id.success) return { ok: false, message: "Invalid scene id" };
  let planId: string | null = null;
  try {
    planId = await db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(productionScenes)
        .where(eq(productionScenes.id, id.data))
        .returning({ planId: productionScenes.planId });
      if (!deleted) return null;
      await renumber(tx, deleted.planId);
      return deleted.planId;
    });
  } catch (error) {
    console.error("deleteScene failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!planId) return { ok: false, message: "Scene not found" };
  revalidateProduction(planId);
  return { ok: true, message: "Scene deleted" };
}

async function renumber(tx: Tx, planId: string, order?: string[]) {
  const ids =
    order ??
    (
      await tx
        .select({ id: productionScenes.id })
        .from(productionScenes)
        .where(eq(productionScenes.planId, planId))
        .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt))
    ).map((s) => s.id);
  for (const [position, sceneId] of ids.entries()) {
    await tx.update(productionScenes).set({ position }).where(eq(productionScenes.id, sceneId));
  }
}

export async function moveScene(sceneId: string, direction: "up" | "down"): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  if (!id.success || (direction !== "up" && direction !== "down")) return { ok: false, message: "Invalid scene" };
  let planId: string | null = null;
  try {
    planId = await db.transaction(async (tx) => {
      const [scene] = await tx
        .select({ planId: productionScenes.planId })
        .from(productionScenes)
        .where(eq(productionScenes.id, id.data));
      if (!scene) return null;
      // Lock the plan so concurrent moves don't interleave.
      await tx.select({ id: productionPlans.id }).from(productionPlans).where(eq(productionPlans.id, scene.planId)).for("update");
      const ordered = await tx
        .select({ id: productionScenes.id })
        .from(productionScenes)
        .where(eq(productionScenes.planId, scene.planId))
        .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt));
      await renumber(tx, scene.planId, moveInOrder(ordered.map((s) => s.id), id.data, direction));
      return scene.planId;
    });
  } catch (error) {
    console.error("moveScene failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!planId) return { ok: false, message: "Scene not found" };
  revalidateProduction(planId);
  return { ok: true, message: direction === "up" ? "Moved up" : "Moved down" };
}

// ---------- Generation ----------

const generateSchema = z.object({
  modelId: z.string().min(1),
  startAssetId: z.uuid().nullish(),
  numImages: z.number().int().min(1).max(4).optional(),
});

export async function generateScene(sceneId: string, options: z.input<typeof generateSchema>): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  const parsed = generateSchema.safeParse(options);
  if (!id.success || !parsed.success) return { ok: false, message: "Invalid generation request" };
  let result: ActionResult;
  try {
    result = await submitApiGeneration({ sceneId: id.data, ...parsed.data });
  } catch (error) {
    console.error("generateScene failed", error);
    return { ok: false, message: DB_ERROR };
  }
  const planId = await planIdOfScene(id.data).catch(() => null);
  if (planId) revalidateProduction(planId, id.data);
  return result;
}

/** Polled by open plan and scene pages while API jobs are active. */
export async function refreshJobs(scope: {
  planId?: string;
  sceneId?: string;
}): Promise<{ changed: boolean; active: number; message?: string }> {
  const planId = idSchema.safeParse(scope.planId);
  const sceneId = idSchema.safeParse(scope.sceneId);
  if (!planId.success && !sceneId.success) return { changed: false, active: 0 };
  try {
    const result = await refreshActiveJobs(sceneId.success ? { sceneId: sceneId.data } : { planId: planId.data! });
    if (result.changed) {
      const plan = planId.success ? planId.data : await planIdOfScene(sceneId.data!);
      if (plan) revalidateProduction(plan, sceneId.success ? sceneId.data : undefined);
    }
    return result;
  } catch (error) {
    console.error("refreshJobs failed", error);
    return { changed: false, active: 0, message: DB_ERROR };
  }
}

export async function checkJob(jobId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, message: "Invalid job id" };
  try {
    const outcome = await refreshApiJob(id.data);
    const [job] = await db
      .select({ sceneId: generationJobs.sceneId, status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.id, id.data));
    if (!job) return { ok: false, message: "Job not found" };
    const planId = await planIdOfScene(job.sceneId);
    if (planId) revalidateProduction(planId, job.sceneId);
    if (outcome.message) return { ok: false, message: outcome.message };
    return { ok: true, message: outcome.changed ? "Status updated" : "No change yet" };
  } catch (error) {
    console.error("checkJob failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export async function retryJob(jobId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, message: "Invalid job id" };
  try {
    const result = await retryApiJob(id.data);
    const [job] = await db.select({ sceneId: generationJobs.sceneId }).from(generationJobs).where(eq(generationJobs.id, id.data));
    const planId = job ? await planIdOfScene(job.sceneId) : null;
    if (planId) revalidateProduction(planId, job!.sceneId);
    return result;
  } catch (error) {
    console.error("retryJob failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export async function cancelJob(jobId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, message: "Invalid job id" };
  try {
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, id.data));
    if (!job) return { ok: false, message: "Job not found" };
    if (job.mode === "api") {
      if (job.status !== "queued" || !job.externalRequestId) {
        return { ok: false, message: "Only queued requests can be canceled" };
      }
      const client = getHiggsfieldClient();
      if (!client) return { ok: false, message: "Higgsfield API is not configured" };
      try {
        await client.cancel(job.externalRequestId);
      } catch {
        return { ok: false, message: "Higgsfield has already started this request, so it can't be canceled" };
      }
    } else if (job.status !== "awaiting_manual") {
      return { ok: false, message: "This manual job is already closed" };
    }
    await db.transaction(async (tx) => {
      await tx
        .update(generationJobs)
        .set({ status: "canceled", completedAt: new Date(), error: null })
        .where(eq(generationJobs.id, job.id));
      await syncSceneStatus(tx, job.sceneId);
    });
    const planId = await planIdOfScene(job.sceneId);
    if (planId) revalidateProduction(planId, job.sceneId);
    return { ok: true, message: "Canceled" };
  } catch (error) {
    console.error("cancelJob failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

/** Records that a scene is being generated by hand in the Higgsfield web app. */
export async function startManualJob(sceneId: string, outputKind: string): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  const kind = z.enum(ASSET_KINDS).safeParse(outputKind);
  if (!id.success || !kind.success) return { ok: false, message: "Invalid request" };
  try {
    const [row] = await db
      .select({ scene: productionScenes, plan: productionPlans })
      .from(productionScenes)
      .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
      .where(eq(productionScenes.id, id.data));
    if (!row) return { ok: false, message: "Scene not found" };
    const linked = await db
      .select({ name: characters.name, visualDescription: characters.visualDescription })
      .from(sceneCharacters)
      .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
      .where(eq(sceneCharacters.sceneId, id.data));
    await db.transaction(async (tx) => {
      await tx.insert(generationJobs).values({
        sceneId: id.data,
        mode: "manual",
        provider: "higgsfield",
        outputKind: kind.data,
        status: "awaiting_manual",
        prompt: buildGenerationPrompt({
          visualPrompt: row.scene.visualPrompt,
          characters: linked,
          visualStyle: row.plan.visualStyle,
        }),
        negativePrompt: row.scene.negativePrompt || null,
      });
      await syncSceneStatus(tx, id.data);
    });
    revalidateProduction(row.plan.id, id.data);
  } catch (error) {
    console.error("startManualJob failed", error);
    return { ok: false, message: DB_ERROR };
  }
  return { ok: true, message: "Manual job started. Generate in Higgsfield, then import the result here." };
}

// ---------- Assets ----------

const importSchema = z.object({
  sceneId: z.uuid(),
  url: z.string().trim().min(1, "Paste the file URL"),
  jobId: z.uuid().nullish(),
  replacesId: z.uuid().nullish(),
  durationSeconds: z.number().positive().max(3600).nullish(),
  model: z.string().trim().max(120).nullish(),
});

/** Downloads a file the user generated manually (e.g. a Higgsfield share/download URL). */
export async function importAssetFromUrl(input: z.input<typeof importSchema>): Promise<ActionResult> {
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const { sceneId, url, jobId, replacesId, durationSeconds, model } = parsed.data;

  const planId = await planIdOfScene(sceneId).catch(() => null);
  if (!planId) return { ok: false, message: "Scene not found" };

  let file: Awaited<ReturnType<typeof downloadMedia>>;
  try {
    file = await downloadMedia(url, `scenes/${sceneId}`);
  } catch (error) {
    return { ok: false, message: error instanceof MediaError ? error.message : "Could not download the file" };
  }

  try {
    await db.transaction(async (tx) => {
      const prompt = jobId
        ? (await tx.select({ prompt: generationJobs.prompt }).from(generationJobs).where(eq(generationJobs.id, jobId)))[0]?.prompt
        : null;
      await addAsset(tx, {
        sceneId,
        jobId,
        kind: file.kind,
        source: "manual_import",
        provider: "Higgsfield (manual)",
        model: model || null,
        filePath: file.filePath,
        sourceUrl: url,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        durationSeconds: file.kind === "video" ? (durationSeconds ?? null) : null,
        prompt,
        replacesId,
      });
    });
  } catch (error) {
    console.error("importAssetFromUrl failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateProduction(planId, sceneId);
  return { ok: true, message: "Imported. Review it before using it as the final asset." };
}

const reviewSchema = z.object({
  decision: z.enum(["approved", "rejected", "pending_review"]),
  notes: z.string().trim().max(1000).default(""),
});

// Approval is always a person's decision; nothing is approved automatically.
export async function reviewAsset(assetId: string, review: z.input<typeof reviewSchema>): Promise<ActionResult> {
  const id = idSchema.safeParse(assetId);
  const parsed = reviewSchema.safeParse(review);
  if (!id.success || !parsed.success) return { ok: false, message: "Invalid review" };

  let scope: { sceneId: string | null; characterId: string | null } | null;
  try {
    scope = await db.transaction(async (tx) => {
      const [asset] = await tx
        .update(assets)
        .set({
          status: parsed.data.decision,
          reviewNotes: parsed.data.notes || null,
          reviewedAt: parsed.data.decision === "pending_review" ? null : new Date(),
        })
        .where(eq(assets.id, id.data))
        .returning({ sceneId: assets.sceneId, characterId: assets.characterId });
      if (!asset) return null;
      if (parsed.data.decision !== "approved") {
        // An asset that isn't approved can't stay the final pick or a primary reference.
        if (asset.sceneId) {
          await tx
            .update(productionScenes)
            .set({ selectedAssetId: null })
            .where(and(eq(productionScenes.id, asset.sceneId), eq(productionScenes.selectedAssetId, id.data)));
        }
        await tx
          .update(characters)
          .set({ primaryReferenceId: null })
          .where(eq(characters.primaryReferenceId, id.data));
      }
      if (asset.sceneId) await syncSceneStatus(tx, asset.sceneId);
      return asset;
    });
  } catch (error) {
    console.error("reviewAsset failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!scope) return { ok: false, message: "Asset not found" };

  const planId = scope.sceneId ? await planIdOfScene(scope.sceneId).catch(() => null) : null;
  revalidateProduction(planId ?? undefined, scope.sceneId ?? undefined);
  if (scope.characterId) revalidatePath(`/characters/${scope.characterId}`);
  const labels = { approved: "Approved", rejected: "Rejected. The file is kept.", pending_review: "Moved back to review" };
  return { ok: true, message: labels[parsed.data.decision] };
}

/** Removes a scene asset's record. Clears it as the final pick; the file stays in the media folder. */
export async function deleteSceneAsset(assetId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(assetId);
  if (!id.success) return { ok: false, message: "Invalid asset id" };

  let sceneId: string | null;
  try {
    sceneId = await db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(assets)
        .where(and(eq(assets.id, id.data), isNotNull(assets.sceneId)))
        .returning({ sceneId: assets.sceneId });
      if (!deleted?.sceneId) return null;
      await syncSceneStatus(tx, deleted.sceneId);
      return deleted.sceneId;
    });
  } catch (error) {
    console.error("deleteSceneAsset failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!sceneId) return { ok: false, message: "Asset not found" };
  const planId = await planIdOfScene(sceneId).catch(() => null);
  revalidateProduction(planId ?? undefined, sceneId);
  return { ok: true, message: "Asset removed from the scene. The file stays in the media folder." };
}

/** Sets (or clears, with null) the scene's final asset. Only approved assets qualify. */
export async function selectSceneAsset(sceneId: string, assetId: string | null): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  const asset = assetId === null ? null : idSchema.safeParse(assetId);
  if (!id.success || (asset && !asset.success)) return { ok: false, message: "Invalid selection" };

  let outcome: ActionResult & { planId?: string };
  try {
    outcome = await db.transaction(async (tx) => {
      if (asset?.success) {
        const [row] = await tx
          .select({ status: assets.status })
          .from(assets)
          .where(and(eq(assets.id, asset.data), eq(assets.sceneId, id.data)));
        if (!row) return { ok: false, message: "That asset doesn't belong to this scene" };
        if (row.status !== "approved") return { ok: false, message: "Approve the asset after reviewing it first" };
      }
      const [scene] = await tx
        .update(productionScenes)
        .set({ selectedAssetId: asset?.success ? asset.data : null })
        .where(eq(productionScenes.id, id.data))
        .returning({ planId: productionScenes.planId });
      if (!scene) return { ok: false, message: "Scene not found" };
      await syncSceneStatus(tx, id.data);
      return { ok: true, message: asset ? "Set as the scene's final asset" : "Final asset cleared", planId: scene.planId };
    });
  } catch (error) {
    console.error("selectSceneAsset failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (outcome.ok && "planId" in outcome && outcome.planId) revalidateProduction(outcome.planId, id.data);
  return { ok: outcome.ok, message: outcome.message } as ActionResult;
}

/**
 * Makes an approved scene image the primary reference of every character linked to the scene, so
 * later generations with a reference-image model keep their look. The file is shared, not copied.
 */
export async function setSceneImageAsReference(assetId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(assetId);
  if (!id.success) return { ok: false, message: "Invalid asset" };

  let outcome: ActionResult & { characterIds?: string[] };
  try {
    outcome = await db.transaction(async (tx) => {
      const [source] = await tx.select().from(assets).where(eq(assets.id, id.data));
      if (!source?.sceneId) return { ok: false, message: "Asset not found" };
      if (source.kind !== "image" || source.status !== "approved") {
        return { ok: false, message: "Approve the image before using it as a reference" };
      }
      if (!source.filePath) return { ok: false, message: "The image file isn't stored locally" };

      const linked = await tx
        .select({ id: characters.id, name: characters.name })
        .from(sceneCharacters)
        .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
        .where(eq(sceneCharacters.sceneId, source.sceneId));
      if (!linked.length) return { ok: false, message: "Link characters to this scene first" };

      for (const character of linked) {
        const [existing] = await tx
          .select({ id: assets.id, status: assets.status })
          .from(assets)
          .where(and(eq(assets.characterId, character.id), eq(assets.filePath, source.filePath)));
        let refId = existing?.id;
        if (!refId) {
          refId = (
            await addAsset(tx, {
              characterId: character.id,
              kind: "image",
              source: source.source,
              provider: source.provider,
              model: source.model,
              filePath: source.filePath,
              sourceUrl: source.sourceUrl,
              contentType: source.contentType,
              sizeBytes: source.sizeBytes,
              prompt: source.prompt,
              metadata: { fromSceneAssetId: source.id },
            })
          ).id;
        }
        // The scene image was already reviewed and approved by a person.
        if (existing?.status !== "approved") {
          await tx
            .update(assets)
            .set({ status: "approved", reviewedAt: new Date(), reviewNotes: "Approved as a scene keyframe" })
            .where(eq(assets.id, refId));
        }
        await tx.update(characters).set({ primaryReferenceId: refId }).where(eq(characters.id, character.id));
      }
      return {
        ok: true,
        message: `Now the primary reference for ${linked.map((c) => c.name).join(", ")}`,
        characterIds: linked.map((c) => c.id),
      };
    });
  } catch (error) {
    console.error("setSceneImageAsReference failed", error);
    return { ok: false, message: DB_ERROR };
  }
  for (const characterId of outcome.characterIds ?? []) revalidatePath(`/characters/${characterId}`);
  revalidatePath("/characters");
  revalidatePath("/production", "layout");
  return { ok: outcome.ok, message: outcome.message } as ActionResult;
}
