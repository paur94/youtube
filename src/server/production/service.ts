import "server-only";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  assets,
  characters,
  generationJobs,
  productionPlans,
  productionScenes,
  sceneCharacters,
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
import { buildRequestBody, generatesAudio, getHiggsfieldModel, outputDuration } from "@/lib/higgsfield";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  type AssetKind,
  type AssetSource,
  buildGenerationPrompt,
  deriveSceneStatus,
  describeDialogue,
  DIALOGUE_NEGATIVE_PROMPT,
  describeReferenceImages,
  findPromptConcerns,
  JOB_TIMEOUT_MS,
  POLLABLE_JOB_STATUSES,
} from "@/lib/production";
import { downloadMedia, MediaError, resolveMediaPath, saveInputFile } from "@/server/media/storage";
import { getHedraClient, HEDRA_NOT_CONFIGURED_MESSAGE, HedraError } from "@/server/providers/hedra";
import {
  getHiggsfieldClient,
  type HiggsfieldClient,
  HiggsfieldError,
  NOT_CONFIGURED_MESSAGE,
} from "@/server/providers/higgsfield";

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

  // Any production activity moves a plan out of planning; any unapproved scene blocks assembly.
  const [plan] = await tx
    .select({ status: productionPlans.status })
    .from(productionPlans)
    .where(eq(productionPlans.id, scene.planId));
  if (plan?.status === "ready_for_assembly" && status !== "approved") {
    await tx.update(productionPlans).set({ status: "in_production" }).where(eq(productionPlans.id, scene.planId));
  } else if (plan?.status === "planning" && (jobs.length > 0 || sceneAssets.length > 0)) {
    await tx.update(productionPlans).set({ status: "in_production" }).where(eq(productionPlans.id, scene.planId));
  }
  return status;
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

/** Inserts an asset as "needs review", completes a linked manual job and updates the scene. */
export async function addAsset(tx: Tx, asset: NewAsset) {
  const revision = await nextRevision(tx, asset);
  const [row] = await tx
    .insert(assets)
    .values({
      ...asset,
      durationSeconds: asset.durationSeconds == null ? null : String(asset.durationSeconds),
      status: "pending_review",
      revision,
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
  const linked = await db
    .select({
      id: characters.id,
      name: characters.name,
      visualDescription: characters.visualDescription,
      primaryReferenceId: characters.primaryReferenceId,
    })
    .from(sceneCharacters)
    .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
    .where(eq(sceneCharacters.sceneId, sceneId))
    .orderBy(asc(characters.name));
  const prompt = buildGenerationPrompt({
    visualPrompt: row.scene.visualPrompt,
    characters: linked,
    visualStyle: row.plan.visualStyle,
  });
  return { ...row, characters: linked, prompt };
}

type CharacterRef = { id: string; name: string; primaryReferenceId: string | null };

/**
 * One approved reference image per character (the primary one when set), in the given order.
 * Characters sharing a file (a group keyframe) are grouped so the image is sent once.
 */
export async function pickCharacterReferences(linked: CharacterRef[]) {
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
    const asset = own.find((a) => a.id === c.primaryReferenceId) ?? own[0];
    if (!asset) continue;
    const key = asset.filePath ?? asset.sourceUrl ?? asset.id;
    const group = groups.get(key);
    if (group) group.names.push(c.name);
    else groups.set(key, { names: [c.name], asset });
  }
  return [...groups.values()];
}

/** Makes a stored image readable by Higgsfield: uploads the local file, or falls back to its source URL. */
async function publicImageUrl(client: HiggsfieldClient, asset: typeof assets.$inferSelect) {
  const file = asset.filePath ? resolveMediaPath(asset.filePath) : null;
  if (file && asset.contentType) return client.uploadFile(new Uint8Array(await readFile(file)), asset.contentType);
  return asset.sourceUrl;
}

export type SubmitOptions = {
  sceneId: string;
  modelId: string;
  /** Approved image asset used as the first frame for image-to-video models. */
  startAssetId?: string | null;
  numImages?: number;
};

/** Submits an automated Higgsfield generation for a scene. */
export async function submitApiGeneration(options: SubmitOptions): Promise<ServiceResult> {
  const client = getHiggsfieldClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  const model = getHiggsfieldModel(options.modelId);
  if (!model) return { ok: false, message: "Choose a supported Higgsfield model" };

  const loaded = await loadSceneForGeneration(options.sceneId);
  if (!loaded) return { ok: false, message: "Scene not found" };
  const { scene, plan } = loaded;
  let prompt = loaded.prompt;
  if (!scene.visualPrompt.trim()) return { ok: false, message: "Add a visual prompt to the scene first" };

  let negativePrompt = scene.negativePrompt;
  if (generatesAudio(model)) {
    const dialogue = describeDialogue(
      scene.dialogue,
      loaded.characters.map((c) => c.name),
    );
    if (dialogue) {
      prompt = `${prompt}\n\n${dialogue}`;
      negativePrompt = [negativePrompt.trim(), DIALOGUE_NEGATIVE_PROMPT].filter(Boolean).join(", ");
    }
  }

  const concerns = findPromptConcerns(prompt);
  if (concerns.length) return { ok: false, message: `Edit the prompt before generating: ${concerns.join(". ")}.` };

  let imageUrl: string | undefined;
  if (model.input === "image") {
    if (!options.startAssetId) return { ok: false, message: `${model.label} needs an approved start image` };
    const [start] = await db.select().from(assets).where(eq(assets.id, options.startAssetId));
    if (!start || start.kind !== "image" || start.status !== "approved") {
      return { ok: false, message: "The start image must be an approved image" };
    }
    if (start.sceneId !== scene.id && !start.characterId) {
      return { ok: false, message: "Use an image from this scene or a character reference" };
    }
    try {
      imageUrl = (await publicImageUrl(client, start)) ?? undefined;
      if (!imageUrl) return { ok: false, message: "The start image file is missing" };
    } catch (error) {
      return { ok: false, message: error instanceof HiggsfieldError ? error.message : "Could not read the start image" };
    }
  }

  let referenceUrls: string[] | undefined;
  if (model.maxReferenceImages) {
    const refs = (await pickCharacterReferences(loaded.characters)).slice(0, model.maxReferenceImages);
    try {
      const uploaded = await Promise.all(
        refs.map(async (r) => ({ names: r.names, url: await publicImageUrl(client, r.asset) })),
      );
      const usable = uploaded.filter((r): r is { names: string[]; url: string } => Boolean(r.url));
      if (usable.length) {
        referenceUrls = usable.map((r) => r.url);
        prompt = `${prompt}

${describeReferenceImages(usable.map((r) => r.names))}`;
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof HiggsfieldError ? error.message : "Could not read a character reference image",
      };
    }
  }

  const aspectRatio = (ASPECT_RATIOS as readonly string[]).includes(plan.aspectRatio)
    ? (plan.aspectRatio as AspectRatio)
    : "16:9";
  const body = buildRequestBody(model, {
    prompt,
    negativePrompt,
    aspectRatio,
    durationSeconds: scene.durationSeconds,
    imageUrl,
    numImages: options.numImages,
    referenceUrls,
  });
  const estimate = (await client.estimate(model.path, body));
  const idempotencyKey = randomUUID();

  const [job] = await db
    .insert(generationJobs)
    .values({
      sceneId: scene.id,
      mode: "api",
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

  return sendJob(job.id, scene.id, "Higgsfield", async () => {
    const response = await client.submit(model.path, body, idempotencyKey);
    return { requestId: response.request_id, running: response.status === "in_progress" };
  });
}

function providerLabel(provider: string) {
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
    const message =
      error instanceof HiggsfieldError || error instanceof HedraError || error instanceof MediaError
        ? error.message
        : `Submitting to ${label} failed`;
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
  if (!start || start.kind !== "image" || start.status !== "approved") {
    return { ok: false, message: "The start image must be an approved image" };
  }
  if (start.sceneId !== scene.id && !start.characterId) {
    return { ok: false, message: "Use an image from this scene or a character reference" };
  }
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
    : "16:9";
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
  const client = getHiggsfieldClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  const idempotencyKey = randomUUID();
  const [retry] = await db
    .insert(generationJobs)
    .values({
      sceneId: job.sceneId,
      mode: "api",
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
  return sendJob(retry.id, job.sceneId, "Higgsfield", async () => {
    const response = await client.submit(model.path, body, idempotencyKey);
    return { requestId: response.request_id, running: response.status === "in_progress" };
  });
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

  const client = isHedra ? null : getHiggsfieldClient();
  const hedra = isHedra ? getHedraClient() : null;
  if (!client && !hedra) return { changed: false, message: isHedra ? HEDRA_NOT_CONFIGURED_MESSAGE : NOT_CONFIGURED_MESSAGE };

  let remote;
  try {
    remote = hedra
      ? hedraToRemoteStatus(await hedra.getJob(job.externalRequestId))
      : await client!.getStatus(job.externalRequestId);
  } catch (error) {
    // Transient problems leave the job active; the next poll tries again.
    await db.update(generationJobs).set({ lastCheckedAt: new Date() }).where(eq(generationJobs.id, job.id));
    return {
      changed: false,
      message: error instanceof HiggsfieldError || error instanceof HedraError ? error.message : "Status check failed",
    };
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
  if (client && update.status === "timed_out" && remote.status === "queued") {
    // Best effort: a request canceled while queued is refunded.
    await client.cancel(job.externalRequestId).catch(() => undefined);
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
        source: isHedra ? "hedra_api" : "higgsfield_api",
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
  if (!getHiggsfieldClient() && !getHedraClient()) return { changed: false, active: 0, message: NOT_CONFIGURED_MESSAGE };
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
