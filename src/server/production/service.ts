import "server-only";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  type Asset,
  type ProductionPlan,
  type ProductionScene,
  assets,
  characters,
  generationJobs,
  productionPlans,
  productionScenes,
  sceneCharacters,
  stories,
} from "@/db/schema";
import { interpretRemoteStatus } from "@/lib/generation-jobs";
import {
  checkHedraAudio,
  HEDRA_AUDIO_TYPES,
  HEDRA_IMAGE_TYPES,
  HEDRA_JOB_TIMEOUT_MS,
  HEDRA_MODEL,
  HEDRA_PROVIDER,
  type HedraJobRequest,
  type HedraResolution,
  hedraToRemoteStatus,
  isHedraJobRequest,
  MAX_HEDRA_IMAGE_BYTES,
} from "@/lib/hedra";
import type { RemoteStatus } from "@/lib/generation-jobs";
import {
  buildRequestBody,
  generatesAudio,
  getHiggsfieldModel,
  type HiggsfieldModel,
  modelDuration,
  outputDuration,
} from "@/lib/higgsfield";
import {
  checkKlingImage,
  checkKlingImageCounts,
  describeKlingFrames,
  readImageSize,
  readSceneFrames,
  type SceneFrames,
} from "@/lib/kling";
import { estimateReplicateCost, REPLICATE_PROVIDER, replicateToRemoteStatus } from "@/lib/replicate";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type AssetKind,
  type AssetSource,
  buildGenerationPrompt,
  buildVideoPrompt,
  clipMusicMood,
  deriveSceneStatus,
  DIALOGUE_NEGATIVE_PROMPT,
  describeReferenceImages,
  VIDEO_NEGATIVE_PROMPT,
  findPromptConcerns,
  isReadyForAssembly,
  JOB_TIMEOUT_MS,
  type PlanStatus,
  POLLABLE_JOB_STATUSES,
  resolveLook,
} from "@/lib/production";
import { readSceneContinuity } from "@/lib/story-qc";
import { downloadMedia, MediaError, resolveMediaPath, saveInputFile } from "@/server/media/storage";
import { advanceIdeaStatus } from "@/server/pipeline";
import { getHedraClient, HEDRA_NOT_CONFIGURED_MESSAGE, HedraError } from "@/server/providers/hedra";
import { getHiggsfieldClient, HiggsfieldError, NOT_CONFIGURED_MESSAGE } from "@/server/providers/higgsfield";
import { getReplicateClient, REPLICATE_NOT_CONFIGURED_MESSAGE, ReplicateError } from "@/server/providers/replicate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type ServiceResult = { ok: true; message: string } | { ok: false; message: string };

// A job inserted but never submitted (e.g. the server stopped mid-request) is failed after this.
const UNSUBMITTED_GRACE_MS = 5 * 60_000;

/** Recomputes a scene's production status (and its plan's) from its jobs and assets. */
export async function syncSceneStatus(tx: Executor, sceneId: string) {
  const [scene] = await tx
    .select({
      planId: productionScenes.planId,
      visualPrompt: productionScenes.visualPrompt,
      selectedAssetId: productionScenes.selectedAssetId,
    })
    .from(productionScenes)
    .where(eq(productionScenes.id, sceneId));
  if (!scene) return null;

  const [jobs, sceneAssets] = await Promise.all([
    tx
      .select({ status: generationJobs.status, error: generationJobs.error })
      .from(generationJobs)
      .where(eq(generationJobs.sceneId, sceneId))
      .orderBy(desc(generationJobs.createdAt)),
    tx.select({ id: assets.id, status: assets.status }).from(assets).where(eq(assets.sceneId, sceneId)),
  ]);
  const selected = sceneAssets.find((a) => a.id === scene.selectedAssetId);
  const status = deriveSceneStatus({
    visualPrompt: scene.visualPrompt,
    jobs,
    assets: sceneAssets,
    selectedAssetApproved: selected?.status === "approved",
  });
  await tx
    .update(productionScenes)
    .set({ status, error: status === "failed" ? (jobs[0]?.error ?? "Generation failed") : null })
    .where(eq(productionScenes.id, sceneId));

  await syncPlanStatus(tx, scene.planId, jobs.length > 0 || sceneAssets.length > 0);
  return status;
}

/**
 * A plan is ready for assembly exactly when every scene has an approved final asset (each one was
 * reviewed on its own, so there is no separate sign-off). Any production activity moves a plan
 * out of planning.
 */
export async function syncPlanStatus(tx: Executor, planId: string, activity = false) {
  const [plan] = await tx
    .select({ status: productionPlans.status, storyId: productionPlans.storyId })
    .from(productionPlans)
    .where(eq(productionPlans.id, planId));
  if (!plan) return;
  const scenes = await tx
    .select({ status: productionScenes.status })
    .from(productionScenes)
    .where(eq(productionScenes.planId, planId));

  const next: PlanStatus = isReadyForAssembly(scenes)
    ? "ready_for_assembly"
    : plan.status === "planning" && !activity
      ? "planning"
      : "in_production";
  if (next === plan.status) return;
  await tx.update(productionPlans).set({ status: next }).where(eq(productionPlans.id, planId));
  if (next === "ready_for_assembly") await advanceIdeaStatus(plan.storyId, "generated", tx);
}

async function nextRevision(tx: Executor, owner: { sceneId?: string | null; characterId?: string | null }) {
  const where = owner.sceneId ? eq(assets.sceneId, owner.sceneId) : eq(assets.characterId, owner.characterId!);
  const [{ next }] = await tx
    .select({ next: sql`coalesce(max(${assets.revision}), 0) + 1`.mapWith(Number) })
    .from(assets)
    .where(where);
  return next;
}

export type NewAsset = {
  sceneId?: string | null;
  characterId?: string | null;
  jobId?: string | null;
  kind: AssetKind;
  source: AssetSource;
  provider: string;
  model?: string | null;
  filePath: string | null;
  originalName?: string | null;
  sourceUrl?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  prompt?: string | null;
  replacesId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Swaps the file of an existing asset, keeping its id and revision number so anything pointing at
 * it (keyframes, picked references) uses the new file. The old file stays in the media folder.
 */
async function replaceAsset(tx: Tx, { replacesId, ...asset }: NewAsset & { replacesId: string }) {
  const owner = asset.sceneId ? eq(assets.sceneId, asset.sceneId) : eq(assets.characterId, asset.characterId!);
  const [row] = await tx
    .update(assets)
    .set({
      jobId: asset.jobId ?? null,
      kind: asset.kind,
      source: asset.source,
      provider: asset.provider,
      model: asset.model ?? null,
      filePath: asset.filePath,
      originalName: asset.originalName ?? null,
      sourceUrl: asset.sourceUrl ?? null,
      contentType: asset.contentType ?? null,
      sizeBytes: asset.sizeBytes ?? null,
      durationSeconds: asset.durationSeconds == null ? null : String(asset.durationSeconds),
      prompt: asset.prompt ?? null,
      // The new file needs its own review and vision check.
      metadata: asset.metadata ?? null,
      status: "pending_review",
      reviewNotes: null,
      reviewedAt: null,
      createdAt: new Date(),
    })
    .where(and(eq(assets.id, replacesId), owner))
    .returning({ id: assets.id, revision: assets.revision });
  if (!row) return null;
  // An asset that isn't approved can't stay the final pick or a primary reference.
  await tx.update(productionScenes).set({ selectedAssetId: null }).where(eq(productionScenes.selectedAssetId, row.id));
  await tx.update(characters).set({ primaryReferenceId: null }).where(eq(characters.primaryReferenceId, row.id));
  return row;
}

/**
 * Inserts an asset as "needs review" (or swaps the file of the one it replaces), completes a
 * linked manual job and updates the scene.
 */
export async function addAsset(tx: Tx, asset: NewAsset) {
  const replaced = asset.replacesId ? await replaceAsset(tx, { ...asset, replacesId: asset.replacesId }) : null;
  const [row] = replaced
    ? [replaced]
    : await tx
        .insert(assets)
        .values({
          ...asset,
          replacesId: null,
          durationSeconds: asset.durationSeconds == null ? null : String(asset.durationSeconds),
          status: "pending_review",
          revision: await nextRevision(tx, asset),
        })
        .returning({ id: assets.id, revision: assets.revision });

  if (asset.jobId) {
    await tx
      .update(generationJobs)
      .set({ status: "completed", completedAt: new Date(), error: null })
      .where(
        and(
          eq(generationJobs.id, asset.jobId),
          eq(generationJobs.mode, "manual"),
          eq(generationJobs.status, "awaiting_manual"),
        ),
      );
  }
  if (asset.sceneId) await syncSceneStatus(tx, asset.sceneId);
  return row;
}

/** Scene with plan settings and linked characters, as needed to build its prompt. */
export async function loadSceneForGeneration(sceneId: string) {
  const [row] = await db
    .select({ scene: productionScenes, plan: productionPlans })
    .from(productionScenes)
    .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
    .where(eq(productionScenes.id, sceneId));
  if (!row) return null;
  const linked = (
    await db
      .select({
        id: characters.id,
        name: characters.name,
        visualDescription: characters.visualDescription,
        looks: characters.looks,
        lookId: sceneCharacters.lookId,
        primaryReferenceId: characters.primaryReferenceId,
      })
      .from(sceneCharacters)
      .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
      .where(eq(sceneCharacters.sceneId, sceneId))
      .orderBy(asc(characters.name))
  ).map(({ lookId, ...c }) => resolveLook(c, lookId));
  const prompt = buildGenerationPrompt({
    visualPrompt: row.scene.visualPrompt,
    characters: linked,
    visualStyle: row.plan.visualStyle,
  });
  return { ...row, characters: linked, prompt };
}

/** The music mood a scene's clips ask for, or null when the plan keeps generated clips free of music. */
export async function loadClipMusic(
  plan: Pick<ProductionPlan, "storyId" | "clipMusic">,
  scene: Pick<ProductionScene, "position" | "title">,
) {
  if (plan.clipMusic === "none" || !plan.storyId) return null;
  const [story] = await db.select({ content: stories.content }).from(stories).where(eq(stories.id, plan.storyId));
  return clipMusicMood(plan.clipMusic, story?.content ?? null, scene);
}

type CharacterRef = { id: string; name: string; primaryReferenceId: string | null };

/**
 * One approved reference image per character, in the given order: the first of the scene's picked
 * references that belongs to the character, else its primary one, else its newest.
 * Characters sharing a file (a group keyframe) are grouped so the image is sent once.
 */
export async function pickCharacterReferences(linked: CharacterRef[], sceneRefIds: string[] = []) {
  if (!linked.length) return [];
  const approved = await db
    .select()
    .from(assets)
    .where(
      and(
        inArray(
          assets.characterId,
          linked.map((c) => c.id),
        ),
        eq(assets.kind, "image"),
        eq(assets.status, "approved"),
      ),
    )
    .orderBy(desc(assets.revision));
  const groups = new Map<string, { names: string[]; asset: (typeof approved)[number] }>();
  for (const c of linked) {
    const own = approved.filter((a) => a.characterId === c.id);
    const picked = sceneRefIds.map((id) => own.find((a) => a.id === id)).find(Boolean);
    const asset = picked ?? own.find((a) => a.id === c.primaryReferenceId) ?? own[0];
    if (!asset) continue;
    const key = asset.filePath ?? asset.sourceUrl ?? asset.id;
    const group = groups.get(key);
    if (group) group.names.push(c.name);
    else groups.set(key, { names: [c.name], asset });
  }
  return [...groups.values()];
}

/** Errors whose message is written for the user. */
function isProviderError(error: unknown): error is Error {
  return (
    error instanceof HiggsfieldError ||
    error instanceof ReplicateError ||
    error instanceof HedraError ||
    error instanceof MediaError
  );
}

/** The provider that serves a catalog model (Higgsfield, or Replicate for its Wan 3.0 entries). */
type ApiProvider = {
  label: string;
  uploadFile: (bytes: Uint8Array, contentType: string) => Promise<string>;
  /** USD estimate, or null when none is available. */
  estimate: (body: Record<string, unknown>) => Promise<number | null>;
  submit: (body: Record<string, unknown>, idempotencyKey: string) => Promise<{ requestId: string; running: boolean }>;
};

function getApiProvider(model: HiggsfieldModel): ApiProvider | null {
  if (model.provider === REPLICATE_PROVIDER) {
    const replicate = getReplicateClient();
    return (
      replicate && {
        label: "Replicate",
        uploadFile: (bytes, contentType) => replicate.uploadFile(bytes, contentType),
        estimate: async (body) => estimateReplicateCost(model, body),
        submit: async (body) => {
          const prediction = await replicate.createPrediction(model.path, body);
          return { requestId: prediction.id, running: prediction.status === "processing" };
        },
      }
    );
  }
  const client = getHiggsfieldClient();
  return (
    client && {
      label: "Higgsfield",
      uploadFile: (bytes, contentType) => client.uploadFile(bytes, contentType),
      estimate: (body) => client.estimate(model.path, body),
      submit: async (body, idempotencyKey) => {
        const response = await client.submit(model.path, body, idempotencyKey);
        return { requestId: response.request_id, running: response.status === "in_progress" };
      },
    }
  );
}

function notConfiguredMessage(provider: string | undefined) {
  if (provider === REPLICATE_PROVIDER) return REPLICATE_NOT_CONFIGURED_MESSAGE;
  return provider === HEDRA_PROVIDER ? HEDRA_NOT_CONFIGURED_MESSAGE : NOT_CONFIGURED_MESSAGE;
}

/** Makes a stored image readable by the provider: uploads the local file, or falls back to its source URL. */
async function publicImageUrl(provider: ApiProvider, asset: typeof assets.$inferSelect, role = "start image") {
  const file = asset.filePath ? resolveMediaPath(asset.filePath) : null;
  if (file && asset.contentType) {
    const bytes = await readFile(file).catch(() => null);
    if (!bytes) throw new MediaError(`The ${role} file is missing from storage. Pick another image.`);
    return provider.uploadFile(new Uint8Array(bytes), asset.contentType);
  }
  return asset.sourceUrl;
}

/**
 * Checks an image against Kling's documented rules (format, size, pixel dimensions, aspect ratio) and uploads
 * it. The app stores WebP and GIF images too, which Kling rejects, so this runs before any money is spent.
 * An asset without a local file can only be checked by type; its source URL is sent as is.
 */
async function checkedKlingUpload(provider: ApiProvider, asset: Asset, role: string) {
  const file = asset.filePath ? resolveMediaPath(asset.filePath) : null;
  const bytes = file ? await readFile(file).catch(() => null) : null;
  if (bytes && asset.contentType) {
    const problem = checkKlingImage(
      { contentType: asset.contentType, sizeBytes: bytes.byteLength, size: readImageSize(new Uint8Array(bytes)) },
      role,
    );
    if (problem) throw new MediaError(problem);
    return provider.uploadFile(new Uint8Array(bytes), asset.contentType);
  }
  if (asset.contentType) {
    const problem = checkKlingImage({ contentType: asset.contentType, sizeBytes: asset.sizeBytes }, role);
    if (problem) throw new MediaError(problem);
  }
  if (!asset.sourceUrl) throw new MediaError(`The ${role} file is missing`);
  return asset.sourceUrl;
}

type PreparedKeyframes = { startUrl: string; middleUrls: string[]; endUrl: string | undefined; promptNote: string };

/**
 * Loads the scene's saved Kling keyframes, checks them with the start image against the documented limits
 * and uploads them in order. A keyframe is any non-rejected image of this plan or an approved character
 * reference, like a scene reference; the start image can't double as a middle or end frame.
 */
async function prepareKeyframes(
  provider: ApiProvider,
  scene: Pick<ProductionScene, "id" | "planId">,
  start: Asset,
  frames: SceneFrames,
): Promise<PreparedKeyframes | { problem: string }> {
  const countProblem = checkKlingImageCounts({ start: true, middle: frames.middleAssetIds.length, end: Boolean(frames.endAssetId) });
  if (countProblem) return { problem: countProblem };
  const ids = [...frames.middleAssetIds, ...(frames.endAssetId ? [frames.endAssetId] : [])];
  if (new Set(ids).size !== ids.length) return { problem: "Each keyframe can be used once. Update the frames below." };
  if (ids.includes(start.id)) return { problem: "The start image can't also be a middle or end frame. Update the frames below." };

  const rows = ids.length
    ? await db
        .select({ asset: assets, planId: productionScenes.planId })
        .from(assets)
        .leftJoin(productionScenes, eq(assets.sceneId, productionScenes.id))
        .where(inArray(assets.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.asset.id, r]));
  const keyframes = ids.map((id, i) => ({ id, role: i < frames.middleAssetIds.length ? `middle image ${i + 1}` : "end image" }));
  for (const { id, role } of keyframes) {
    const row = byId.get(id);
    if (!row || row.asset.kind !== "image") return { problem: `The ${role} was deleted. Update the frames below.` };
    if (row.asset.status === "rejected") return { problem: `The ${role} was rejected. Update the frames below.` };
    const ownImage = row.planId === scene.planId;
    const characterReference = Boolean(row.asset.characterId) && row.asset.status === "approved";
    if (!ownImage && !characterReference) return { problem: `The ${role} must be an image from this story or an approved character reference` };
  }

  const startUrl = await checkedKlingUpload(provider, start, "start image");
  const urls = await Promise.all(keyframes.map(({ id, role }) => checkedKlingUpload(provider, byId.get(id)!.asset, role)));
  const middleUrls = urls.slice(0, frames.middleAssetIds.length);
  const endUrl = frames.endAssetId ? urls[urls.length - 1] : undefined;
  return {
    startUrl,
    middleUrls,
    endUrl,
    promptNote: describeKlingFrames({ middle: middleUrls.length, end: Boolean(endUrl) }),
  };
}

export type SubmitOptions = {
  sceneId: string;
  modelId: string;
  /** Image used as the first frame for image-to-video models; see startImageProblem. */
  startAssetId?: string | null;
  numImages?: number;
};

/**
 * A start frame is an approved image of this scene, an approved character reference, or one of the
 * scene's picked references (which may still be awaiting review, but not rejected).
 */
function startImageProblem(start: Asset | undefined, scene: Pick<ProductionScene, "id" | "continuity">) {
  if (!start || start.kind !== "image") return "The start image must be an image";
  const picked = readSceneContinuity(scene.continuity).referenceAssetIds.includes(start.id);
  if (picked) return start.status === "rejected" ? "The start image was rejected" : null;
  if (start.sceneId !== scene.id && !start.characterId) {
    return "Use an image from this scene, a character reference or one of the scene's reference images";
  }
  return start.status === "approved" ? null : "The start image must be approved";
}

/** Submits an automated generation for a scene to the model's provider (Higgsfield or Replicate). */
export async function submitApiGeneration(options: SubmitOptions): Promise<ServiceResult> {
  const model = getHiggsfieldModel(options.modelId);
  if (!model) return { ok: false, message: "Choose a supported model" };
  const client = getApiProvider(model);
  if (!client) return { ok: false, message: notConfiguredMessage(model.provider) };

  const loaded = await loadSceneForGeneration(options.sceneId);
  if (!loaded) return { ok: false, message: "Scene not found" };
  const { scene, plan } = loaded;
  let prompt = loaded.prompt;
  if (!scene.visualPrompt.trim()) return { ok: false, message: "Add a visual prompt to the scene first" };

  let negativePrompt = scene.negativePrompt;
  if (model.output === "video") {
    // The visual prompt describes the keyframe; a clip is driven by the action and dialogue (no voice-over).
    const voiced = generatesAudio(model);
    prompt = buildVideoPrompt({
      visualPrompt: scene.visualPrompt,
      action: scene.action,
      setting: scene.setting,
      dialogue: scene.dialogue,
      characters: loaded.characters,
      visualStyle: plan.visualStyle,
      durationSeconds: modelDuration(model, scene.durationSeconds) ?? scene.durationSeconds,
      startImage: model.input === "image",
      voiced,
      music: await loadClipMusic(plan, scene),
    });
    negativePrompt = [negativePrompt.trim(), VIDEO_NEGATIVE_PROMPT, voiced ? DIALOGUE_NEGATIVE_PROMPT : ""]
      .filter(Boolean)
      .join(", ");
  }

  const concerns = findPromptConcerns(prompt);
  if (concerns.length) return { ok: false, message: `Edit the prompt before generating: ${concerns.join(". ")}.` };

  let imageUrl: string | undefined;
  let middleImageUrls: string[] | undefined;
  let endImageUrl: string | undefined;
  if (model.input === "image") {
    if (!options.startAssetId) return { ok: false, message: `${model.label} needs an approved start image` };
    const [start] = await db.select().from(assets).where(eq(assets.id, options.startAssetId));
    const problem = startImageProblem(start, scene);
    if (problem) return { ok: false, message: problem };
    try {
      if (model.frames) {
        // Kling keyframes: the saved middle and end images travel with the start image, all checked first.
        const prepared = await prepareKeyframes(client, scene, start, readSceneFrames(readSceneContinuity(scene.continuity)));
        if ("problem" in prepared) return { ok: false, message: prepared.problem };
        imageUrl = prepared.startUrl;
        middleImageUrls = prepared.middleUrls;
        endImageUrl = prepared.endUrl;
        if (prepared.promptNote) prompt = `${prompt}\n\n${prepared.promptNote}`;
      } else {
        imageUrl = (await publicImageUrl(client, start)) ?? undefined;
        if (!imageUrl) return { ok: false, message: "The start image file is missing" };
      }
    } catch (error) {
      return { ok: false, message: isProviderError(error) ? error.message : "Could not read the start image" };
    }
  }

  let referenceUrls: string[] | undefined;
  if (model.maxReferenceImages) {
    const sceneRefIds = readSceneContinuity(scene.continuity).referenceAssetIds;
    const refs = (await pickCharacterReferences(loaded.characters, sceneRefIds)).slice(0, model.maxReferenceImages);
    // Extra scene references (props, places, keyframes) fill the remaining slots.
    const sceneRefs = sceneRefIds.length
      ? (await db.select().from(assets).where(and(inArray(assets.id, sceneRefIds), eq(assets.kind, "image"), ne(assets.status, "rejected"))))
          .filter((a) => !refs.some((r) => r.asset.id === a.id))
          .sort((a, b) => sceneRefIds.indexOf(a.id) - sceneRefIds.indexOf(b.id))
          .slice(0, model.maxReferenceImages - refs.length)
      : [];
    try {
      const uploaded = await Promise.all(
        refs.map(async (r) => ({
          names: r.names,
          url: await publicImageUrl(client, r.asset, `reference image for ${r.names.join(" and ")}`),
        })),
      );
      const usable = uploaded.filter((r): r is { names: string[]; url: string } => Boolean(r.url));
      const sceneUrls = (await Promise.all(sceneRefs.map((a) => publicImageUrl(client, a, "scene reference image")))).filter(
        (u): u is string => Boolean(u),
      );
      if (usable.length || sceneUrls.length) {
        referenceUrls = [...usable.map((r) => r.url), ...sceneUrls];
        prompt = `${prompt}

${describeReferenceImages(usable.map((r) => r.names), sceneUrls.length, model.imageTags)}`;
      }
    } catch (error) {
      return {
        ok: false,
        message: isProviderError(error) ? error.message : "Could not read a character reference image",
      };
    }
  }

  const aspectRatio = (ASPECT_RATIOS as readonly string[]).includes(plan.aspectRatio)
    ? (plan.aspectRatio as AspectRatio)
    : "9:16";
  const body = buildRequestBody(model, {
    prompt,
    negativePrompt,
    aspectRatio,
    durationSeconds: scene.durationSeconds,
    imageUrl,
    numImages: options.numImages,
    referenceUrls,
    middleImageUrls,
    endImageUrl,
  });
  const estimate = await client.estimate(body);
  const idempotencyKey = randomUUID();

  const [job] = await db
    .insert(generationJobs)
    .values({
      sceneId: scene.id,
      mode: "api",
      provider: model.provider ?? "higgsfield",
      model: model.id,
      outputKind: model.output,
      status: "queued",
      prompt,
      negativePrompt: model.supportsNegativePrompt ? negativePrompt || null : null,
      request: body,
      idempotencyKey,
      estimatedCostUsd: estimate === null ? null : String(estimate),
    })
    .returning({ id: generationJobs.id });

  return sendJob(job.id, scene.id, client.label, () => client.submit(body, idempotencyKey));
}

function providerLabel(provider: string) {
  if (provider === REPLICATE_PROVIDER) return "Replicate";
  return provider === HEDRA_PROVIDER ? "Hedra" : "Higgsfield";
}

/** Submits a job to its provider and records the provider's request id, or the failure. */
async function sendJob(
  jobId: string,
  sceneId: string,
  label: string,
  submit: () => Promise<{ requestId: string; running: boolean }>,
): Promise<ServiceResult> {
  try {
    const response = await submit();
    await db.transaction(async (tx) => {
      await tx
        .update(generationJobs)
        .set({
          externalRequestId: response.requestId,
          status: response.running ? "in_progress" : "queued",
          submittedAt: new Date(),
          lastCheckedAt: new Date(),
        })
        .where(eq(generationJobs.id, jobId));
      await syncSceneStatus(tx, sceneId);
    });
    return { ok: true, message: `Submitted to ${label}. Status updates automatically while this page is open.` };
  } catch (error) {
    const message = isProviderError(error) ? error.message : `Submitting to ${label} failed`;
    await db.transaction(async (tx) => {
      await tx
        .update(generationJobs)
        .set({ status: "failed", error: message, completedAt: new Date() })
        .where(eq(generationJobs.id, jobId));
      await syncSceneStatus(tx, sceneId);
    });
    return { ok: false, message };
  }
}

export type HedraSubmitOptions = {
  sceneId: string;
  /** Approved image the character is animated from. */
  startAssetId: string;
  resolution: HedraResolution;
  audio: { bytes: Uint8Array; contentType: string };
};

/** Submits a Hedra Character 3 render: the start image's character speaks the uploaded audio. */
export async function submitHedraGeneration(options: HedraSubmitOptions): Promise<ServiceResult> {
  if (!getHedraClient()) return { ok: false, message: HEDRA_NOT_CONFIGURED_MESSAGE };

  const audioProblem = checkHedraAudio(options.audio.contentType, options.audio.bytes.byteLength);
  if (audioProblem) return { ok: false, message: audioProblem };

  const loaded = await loadSceneForGeneration(options.sceneId);
  if (!loaded) return { ok: false, message: "Scene not found" };
  const { scene, plan, prompt } = loaded;
  if (!scene.visualPrompt.trim()) return { ok: false, message: "Add a visual prompt to the scene first" };
  const concerns = findPromptConcerns(prompt);
  if (concerns.length) return { ok: false, message: `Edit the prompt before generating: ${concerns.join(". ")}.` };

  const [start] = await db.select().from(assets).where(eq(assets.id, options.startAssetId));
  const startProblem = startImageProblem(start, scene);
  if (startProblem) return { ok: false, message: startProblem };
  if (!start.filePath || !start.contentType || !resolveMediaPath(start.filePath)) {
    return { ok: false, message: "The start image file is missing" };
  }
  if (!HEDRA_IMAGE_TYPES.includes(start.contentType)) return { ok: false, message: "Hedra needs a PNG, JPEG or WebP start image" };
  if ((start.sizeBytes ?? 0) > MAX_HEDRA_IMAGE_BYTES) return { ok: false, message: "Hedra start images must be 10 MB or smaller" };

  const audioPath = await saveInputFile(
    options.audio.bytes,
    HEDRA_AUDIO_TYPES[options.audio.contentType],
    `scenes/${scene.id}/inputs`,
  );
  const aspectRatio = (ASPECT_RATIOS as readonly string[]).includes(plan.aspectRatio)
    ? (plan.aspectRatio as AspectRatio)
    : "9:16";
  const request: HedraJobRequest = {
    input: { prompt, aspect_ratio: aspectRatio, resolution: options.resolution },
    startImage: { filePath: start.filePath, contentType: start.contentType },
    audio: { filePath: audioPath, contentType: options.audio.contentType },
  };
  const idempotencyKey = randomUUID();

  const [job] = await db
    .insert(generationJobs)
    .values({
      sceneId: scene.id,
      mode: "api",
      provider: HEDRA_PROVIDER,
      model: HEDRA_MODEL.id,
      outputKind: "video",
      status: "queued",
      prompt,
      request,
      idempotencyKey,
    })
    .returning({ id: generationJobs.id });

  return sendHedraJob(job.id, request, idempotencyKey, scene.id);
}

/** Uploads the stored inputs (handles expire after an hour, so on every send) and submits the job. */
function sendHedraJob(jobId: string, request: HedraJobRequest, idempotencyKey: string, sceneId: string) {
  const client = getHedraClient();
  if (!client) return Promise.resolve<ServiceResult>({ ok: false, message: HEDRA_NOT_CONFIGURED_MESSAGE });

  return sendJob(jobId, sceneId, "Hedra", async () => {
    const upload = async (file: { filePath: string; contentType: string }) => {
      const full = resolveMediaPath(file.filePath);
      const bytes = full ? await readFile(full).catch(() => null) : null;
      if (!bytes) throw new MediaError("A stored input file for this job is missing. Start a new generation.");
      return client.uploadFile(new Uint8Array(bytes), file.contentType, file.filePath.split("/").pop()!);
    };
    const [imageUrl, audioUrl] = await Promise.all([upload(request.startImage), upload(request.audio)]);
    const response = await client.submit(
      HEDRA_MODEL.id,
      {
        ...request.input,
        start_image: { source: "url", url: imageUrl },
        audio: { source: "url", url: audioUrl },
      },
      idempotencyKey,
    );
    return { requestId: response.job_id, running: response.status === "IN_PROGRESS" };
  });
}

/** Re-sends a failed or timed-out API job as a new attempt with the same request body. */
export async function retryApiJob(jobId: string): Promise<ServiceResult> {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job) return { ok: false, message: "Job not found" };
  if (job.mode !== "api" || !job.request || !job.model) {
    return { ok: false, message: "Only automated jobs can be retried. Import a new file for manual jobs." };
  }
  if (!["failed", "nsfw", "timed_out", "canceled"].includes(job.status)) {
    return { ok: false, message: "Only failed, timed-out or canceled jobs can be retried" };
  }

  if (job.provider === HEDRA_PROVIDER) {
    if (!isHedraJobRequest(job.request)) return { ok: false, message: "This job can't be retried. Start a new generation." };
    if (!getHedraClient()) return { ok: false, message: HEDRA_NOT_CONFIGURED_MESSAGE };
    const idempotencyKey = randomUUID();
    const [retry] = await db
      .insert(generationJobs)
      .values({
        sceneId: job.sceneId,
        mode: "api",
        provider: HEDRA_PROVIDER,
        model: job.model,
        outputKind: job.outputKind,
        status: "queued",
        prompt: job.prompt,
        request: job.request,
        idempotencyKey,
        attempt: job.attempt + 1,
        retryOfId: job.id,
      })
      .returning({ id: generationJobs.id });
    return sendHedraJob(retry.id, job.request, idempotencyKey, job.sceneId);
  }

  const model = getHiggsfieldModel(job.model);
  if (!model) return { ok: false, message: "This model is no longer supported. Start a new generation." };
  const client = getApiProvider(model);
  if (!client) return { ok: false, message: notConfiguredMessage(model.provider) };

  const idempotencyKey = randomUUID();
  const [retry] = await db
    .insert(generationJobs)
    .values({
      sceneId: job.sceneId,
      mode: "api",
      provider: job.provider,
      model: job.model,
      outputKind: job.outputKind,
      status: "queued",
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      request: job.request,
      idempotencyKey,
      estimatedCostUsd: job.estimatedCostUsd,
      attempt: job.attempt + 1,
      retryOfId: job.id,
    })
    .returning({ id: generationJobs.id });
  const body = job.request;
  return sendJob(retry.id, job.sceneId, client.label, () => client.submit(body, idempotencyKey));
}

/** Status polling (and best-effort cancel) for a job's provider, or null when it isn't configured. */
function getStatusReader(provider: string) {
  if (provider === HEDRA_PROVIDER) {
    const hedra = getHedraClient();
    return hedra && { get: async (id: string) => hedraToRemoteStatus(await hedra.getJob(id)), cancel: null };
  }
  if (provider === REPLICATE_PROVIDER) {
    const replicate = getReplicateClient();
    return (
      replicate && {
        get: async (id: string) => replicateToRemoteStatus(await replicate.getPrediction(id)),
        cancel: (id: string) => replicate.cancel(id),
      }
    );
  }
  const client = getHiggsfieldClient();
  return client && { get: (id: string): Promise<RemoteStatus> => client.getStatus(id), cancel: (id: string) => client.cancel(id) };
}

export type RefreshOutcome = { changed: boolean; message?: string };

/**
 * Polls one API job. Downloads completed outputs to local storage (provider URLs expire) and
 * records them as assets that need review. Timed-out jobs can be checked again on request.
 */
export async function refreshApiJob(jobId: string): Promise<RefreshOutcome> {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job || job.mode !== "api") return { changed: false };
  const recheck = job.status === "timed_out";
  if (!POLLABLE_JOB_STATUSES.includes(job.status) && !recheck) return { changed: false };
  const isHedra = job.provider === HEDRA_PROVIDER;
  const label = providerLabel(job.provider);

  if (!job.externalRequestId) {
    if (Date.now() - job.createdAt.getTime() < UNSUBMITTED_GRACE_MS) return { changed: false };
    await db.transaction(async (tx) => {
      await tx
        .update(generationJobs)
        .set({ status: "failed", error: `The request never reached ${label}. Retry it.`, completedAt: new Date() })
        .where(and(eq(generationJobs.id, job.id), isNull(generationJobs.externalRequestId)));
      await syncSceneStatus(tx, job.sceneId);
    });
    return { changed: true };
  }

  const reader = getStatusReader(job.provider);
  if (!reader) return { changed: false, message: notConfiguredMessage(job.provider) };

  let remote;
  try {
    remote = await reader.get(job.externalRequestId);
  } catch (error) {
    // Transient problems leave the job active; the next poll tries again.
    await db.update(generationJobs).set({ lastCheckedAt: new Date() }).where(eq(generationJobs.id, job.id));
    return { changed: false, message: isProviderError(error) ? error.message : "Status check failed" };
  }

  const timeoutMs = recheck ? Infinity : isHedra ? HEDRA_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS;
  const update = interpretRemoteStatus(remote, job, new Date(), timeoutMs, label);
  if (!update.terminal) {
    const changed = update.status !== job.status;
    await db
      .update(generationJobs)
      .set({ status: update.status, error: null, lastCheckedAt: new Date() })
      .where(eq(generationJobs.id, job.id));
    if (changed) await syncSceneStatus(db, job.sceneId);
    return { changed };
  }
  if (reader.cancel && update.status === "timed_out" && remote.status === "queued") {
    // Best effort: a request canceled while queued is refunded.
    await reader.cancel(job.externalRequestId).catch(() => undefined);
  }

  const model = job.model && !isHedra ? getHiggsfieldModel(job.model) : null;
  const duration = model && job.request ? outputDuration(model, job.request) : null;
  const downloads = await Promise.all(
    update.outputs.map(async (output) => {
      try {
        return { output, file: await downloadMedia(output.url, `scenes/${job.sceneId}`), error: null };
      } catch (error) {
        return { output, file: null, error: error instanceof MediaError ? error.message : "Download failed" };
      }
    }),
  );

  await db.transaction(async (tx) => {
    // Another poll may have finished this job already; only the first one records outputs.
    const [current] = await tx
      .select({ status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.id, job.id))
      .for("update");
    if (!current || (!POLLABLE_JOB_STATUSES.includes(current.status) && current.status !== "timed_out")) return;

    await tx
      .update(generationJobs)
      .set({
        status: update.status,
        error: update.error,
        completedAt: new Date(),
        lastCheckedAt: new Date(),
        outputExpiresAt: update.outputExpiresAt,
      })
      .where(eq(generationJobs.id, job.id));

    for (const { output, file, error } of downloads) {
      await addAsset(tx, {
        sceneId: job.sceneId,
        jobId: job.id,
        kind: file?.kind ?? output.kind,
        source: isHedra ? "hedra_api" : job.provider === REPLICATE_PROVIDER ? "replicate_api" : "higgsfield_api",
        provider: label,
        model: job.model,
        filePath: file?.filePath ?? null,
        sourceUrl: output.url,
        contentType: file?.contentType ?? null,
        sizeBytes: file?.sizeBytes ?? null,
        durationSeconds: (file?.kind ?? output.kind) === "video" ? duration : null,
        prompt: job.prompt,
        metadata: {
          requestId: job.externalRequestId,
          request: job.request,
          ...(error && { downloadError: error }),
          ...(update.outputExpiresAt && { providerExpiresAt: update.outputExpiresAt.toISOString() }),
        },
      });
    }
    await syncSceneStatus(tx, job.sceneId);
  });
  return { changed: true };
}

/** Polls every active API job of a plan (or of one scene). */
export async function refreshActiveJobs(scope: { planId?: string; sceneId?: string }) {
  if (!getHiggsfieldClient() && !getHedraClient() && !getReplicateClient()) return { changed: false, active: 0, message: NOT_CONFIGURED_MESSAGE };
  const where = scope.sceneId
    ? eq(generationJobs.sceneId, scope.sceneId)
    : eq(productionScenes.planId, scope.planId!);
  const jobs = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .innerJoin(productionScenes, eq(generationJobs.sceneId, productionScenes.id))
    .where(and(where, eq(generationJobs.mode, "api"), inArray(generationJobs.status, [...POLLABLE_JOB_STATUSES])))
    .limit(20);

  let changed = false;
  let message: string | undefined;
  for (const job of jobs) {
    const outcome = await refreshApiJob(job.id);
    changed ||= outcome.changed;
    message ??= outcome.message;
  }
  return { changed, active: jobs.length, message };
}
