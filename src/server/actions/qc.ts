"use server";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { assets, characters, productionScenes } from "@/db/schema";
import { getHiggsfieldModel } from "@/lib/higgsfield";
import { readVisionReport } from "@/lib/story-qc";
import { submitApiGeneration } from "@/server/production/service";
import {
  applyPromptCorrections,
  loadPlanQc,
  regenerateFailedScenes,
  restorePreviousPrompt,
  runPreflight,
  runVisionCheck,
  updateSceneContinuity,
} from "@/server/qc/service";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.
// Every action here that calls Claude or a video provider runs only when the user clicks it.

const idSchema = z.uuid();

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

/** Clips inspected per click, so one click can't run up an unexpected bill. */
const MAX_BATCH_INSPECTIONS = 12;

function revalidateQc(planId?: string | null, sceneId?: string | null) {
  revalidatePath("/production");
  revalidatePath("/shorts", "layout");
  revalidatePath("/videos", "layout");
  revalidatePath("/publishing");
  if (planId) revalidatePath(`/production/${planId}`, "layout");
  if (planId && sceneId) revalidatePath(`/production/${planId}/scenes/${sceneId}`);
}

async function planOf(sceneId: string) {
  const [row] = await db.select({ planId: productionScenes.planId }).from(productionScenes).where(eq(productionScenes.id, sceneId));
  return row?.planId ?? null;
}

function guarded(name: string, fn: () => Promise<ActionResult>) {
  return fn().catch((error: unknown) => {
    console.error(`${name} failed`, error);
    return { ok: false as const, message: DB_ERROR };
  });
}

/** Stage 1: Claude reads the whole story for contradictions. Cached per scene script. */
export async function runStoryPreflight(planId: string, force = false): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  return guarded("runStoryPreflight", async () => {
    const result = await runPreflight(id.data, force === true);
    revalidateQc(id.data);
    return result;
  });
}

/** Stage 2: compares one generated clip or keyframe with the story. */
export async function inspectAsset(assetId: string, force = false): Promise<ActionResult> {
  const id = idSchema.safeParse(assetId);
  if (!id.success) return { ok: false, message: "Invalid asset id" };
  return guarded("inspectAsset", async () => {
    const result = await runVisionCheck(id.data, force === true);
    const [row] = await db.select({ sceneId: assets.sceneId }).from(assets).where(eq(assets.id, id.data));
    if (row?.sceneId) revalidateQc(await planOf(row.sceneId), row.sceneId);
    return { ok: result.ok, message: result.message };
  });
}

/** Inspects every scene's final clip (or newest clip) that wasn't checked against its current script. */
export async function inspectPlanClips(planId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  return guarded("inspectPlanClips", async () => {
    const loaded = await loadPlanQc(id.data);
    if (!loaded) return { ok: false, message: "Plan not found" };
    const ids = loaded.scenes.map((s) => s.scene.id);
    const videos = ids.length
      ? await db
          .select()
          .from(assets)
          .where(and(inArray(assets.sceneId, ids), eq(assets.kind, "video")))
          .orderBy(desc(assets.revision))
      : [];
    const todo = loaded.scenes
      .map((s) => {
        const own = videos.filter((a) => a.sceneId === s.scene.id && a.filePath && a.status !== "rejected");
        const target = own.find((a) => a.id === s.scene.selectedAssetId) ?? own[0];
        return target && readVisionReport(target.metadata)?.specHash !== s.state.specHash ? target : null;
      })
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    if (!todo.length) return { ok: true, message: "Every clip is already inspected against its current script." };

    let passed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const asset of todo.slice(0, MAX_BATCH_INSPECTIONS)) {
      const result = await runVisionCheck(asset.id);
      if (!result.ok) {
        errors.push(result.message);
        // Configuration problems repeat for every clip; stop at the first.
        if (errors.length >= 2 && errors[0] === errors[1]) break;
        continue;
      }
      if (result.status === "fail") failed++;
      else passed++;
    }
    revalidateQc(id.data);
    const left = todo.length - MAX_BATCH_INSPECTIONS;
    return {
      ok: passed + failed > 0,
      message:
        `Inspected ${passed + failed} clip${passed + failed === 1 ? "" : "s"}: ${failed} with critical mismatches.` +
        (left > 0 ? ` ${left} more left: run it again.` : "") +
        (errors.length ? ` ${errors[0]}` : ""),
    };
  });
}

export async function applySceneCorrections(sceneId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  if (!id.success) return { ok: false, message: "Invalid scene id" };
  return guarded("applySceneCorrections", async () => {
    const result = await applyPromptCorrections(id.data);
    revalidateQc(await planOf(id.data), id.data);
    return result;
  });
}

export async function restoreScenePrompt(sceneId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  if (!id.success) return { ok: false, message: "Invalid scene id" };
  return guarded("restoreScenePrompt", async () => {
    const result = await restorePreviousPrompt(id.data);
    revalidateQc(await planOf(id.data), id.data);
    return result;
  });
}

const issueIdSchema = z.string().min(3).max(200);

/** A person accepts (or un-accepts) an issue after checking it; dismissed issues stop blocking. */
export async function dismissQcIssue(sceneId: string, issueId: string, dismissed: boolean): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  const issue = issueIdSchema.safeParse(issueId);
  if (!id.success || !issue.success) return { ok: false, message: "Invalid issue" };
  return guarded("dismissQcIssue", async () => {
    const found = await updateSceneContinuity(id.data, (c) => ({
      ...c,
      dismissed: dismissed ? [...new Set([...c.dismissed, issue.data])] : c.dismissed.filter((d) => d !== issue.data),
    }));
    if (!found) return { ok: false, message: "Scene not found" };
    revalidateQc(await planOf(id.data), id.data);
    return { ok: true, message: dismissed ? "Issue dismissed. It no longer blocks generation or publishing." : "Issue restored" };
  });
}

/**
 * Extra reference images for a scene: any image of the same story that wasn't rejected (approved or
 * awaiting review), or an approved character reference.
 */
export async function setSceneReferences(sceneId: string, assetIds: string[]): Promise<ActionResult> {
  const id = idSchema.safeParse(sceneId);
  const ids = z.array(idSchema).max(8, "Use at most 8 scene references").safeParse(assetIds);
  if (!id.success) return { ok: false, message: "Invalid scene id" };
  if (!ids.success) return { ok: false, message: ids.error.issues[0].message };
  return guarded("setSceneReferences", async () => {
    const planId = await planOf(id.data);
    if (!planId) return { ok: false, message: "Scene not found" };
    const unique = [...new Set(ids.data)];
    if (unique.length) {
      const rows = await db
        .select({ id: assets.id, kind: assets.kind, status: assets.status, planId: productionScenes.planId, characterId: characters.id })
        .from(assets)
        .leftJoin(productionScenes, eq(assets.sceneId, productionScenes.id))
        .leftJoin(characters, eq(assets.characterId, characters.id))
        .where(inArray(assets.id, unique));
      const ok = rows.filter(
        (r) => r.kind === "image" && ((r.planId === planId && r.status !== "rejected") || (r.characterId && r.status === "approved")),
      );
      if (ok.length !== unique.length) {
        return { ok: false, message: "References must be images from this story that weren't rejected, or approved character references" };
      }
    }
    await updateSceneContinuity(id.data, (c) => ({ ...c, referenceAssetIds: unique }));
    revalidateQc(planId, id.data);
    return { ok: true, message: unique.length ? `${unique.length} scene reference${unique.length === 1 ? "" : "s"} saved` : "Scene references cleared" };
  });
}

/** Corrects and regenerates only the scenes whose clip failed the vision check. Costs money: user-confirmed. */
export async function regenerateFailedClips(planId: string, confirmed: boolean): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  if (confirmed !== true) return { ok: false, message: "Confirm the regeneration first" };
  return guarded("regenerateFailedClips", async () => {
    const loaded = await loadPlanQc(id.data);
    if (!loaded) return { ok: false, message: "Plan not found" };
    const model = getHiggsfieldModel(loaded.plan.videoModel);
    if (!model) return { ok: false, message: "Choose a supported video model in the production settings" };
    const result = await regenerateFailedScenes(
      id.data,
      (sceneId, modelId, startAssetId) => submitApiGeneration({ sceneId, modelId, startAssetId }),
      model.input === "image",
    );
    revalidateQc(id.data);
    return result;
  });
}
