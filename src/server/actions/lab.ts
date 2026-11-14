"use server";

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { type LabJob, type LabProject, labJobs, labProjects } from "@/db/schema";
import { interpretRemoteStatus } from "@/lib/generation-jobs";
import { buildRequestBody, getHiggsfieldModel, type HiggsfieldModel } from "@/lib/higgsfield";
import { checkKlingImage, readImageSize } from "@/lib/kling";
import {
  buildLabImagePrompt,
  buildLabVideoPrompt,
  LAB_ACTIVE_STATUSES,
  LAB_ASPECT_RATIOS,
  LAB_IMAGE_MODEL,
  LAB_TOPIC_MAX,
  LAB_VIDEO_MODELS,
  type LabStory,
  labStoryOutputSchema,
  labStorySchema,
  type LabVideoMode,
  storyFromOutput,
} from "@/lib/lab";
import { estimateReplicateCost, REPLICATE_PROVIDER, replicateToRemoteStatus } from "@/lib/replicate";
import { buildLabStoryPrompt } from "@/server/ai/lab-prompt";
import { getOpenAIConfig, OPENAI_NOT_CONFIGURED_MESSAGE, runOpenAIStructuredGeneration } from "@/server/ai/openai";
import { downloadMedia, MediaError, resolveMediaPath } from "@/server/media/storage";
import { getHiggsfieldClient, HiggsfieldError, NOT_CONFIGURED_MESSAGE as HIGGSFIELD_NOT_CONFIGURED } from "@/server/providers/higgsfield";
import { getReplicateClient, REPLICATE_NOT_CONFIGURED_MESSAGE, ReplicateError } from "@/server/providers/replicate";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Nothing here is checked against the kids-content rules on purpose;
// the providers' own moderation still applies.

const idSchema = z.uuid();
const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";
const JOB_TIMEOUT_MS = 30 * 60_000;
/** Reference images sent to GPT as vision input; larger files are skipped to keep the request small. */
const VISION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const VISION_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function revalidate() {
  revalidatePath("/adult");
}

async function loadProject(id: string) {
  if (!idSchema.safeParse(id).success) return null;
  const [project] = await db.select().from(labProjects).where(eq(labProjects.id, id));
  return project ?? null;
}

function providerMessage(error: unknown, fallback: string) {
  return error instanceof HiggsfieldError || error instanceof ReplicateError || error instanceof MediaError ? error.message : fallback;
}

async function readStored(filePath: string) {
  const full = resolveMediaPath(filePath);
  const bytes = full ? await readFile(full).catch(() => null) : null;
  return bytes ? new Uint8Array(bytes) : null;
}

export async function updateLabSettings(id: string, input: { topic: string; aspectRatio: string }): Promise<ActionResult> {
  const parsed = z
    .object({ topic: z.string().trim().min(3, "Describe the topic").max(LAB_TOPIC_MAX), aspectRatio: z.enum(LAB_ASPECT_RATIOS) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  try {
    const project = await loadProject(id);
    if (!project) return { ok: false, message: "Project not found" };
    await db.update(labProjects).set({ ...parsed.data, updatedAt: new Date() }).where(eq(labProjects.id, id));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: "Saved" };
}

/** Asks OpenAI (GPT) for a fresh story from the topic and reference images. Replaces the current draft. */
export async function generateLabStory(id: string): Promise<ActionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { ok: false, message: OPENAI_NOT_CONFIGURED_MESSAGE };
  let project: LabProject | null;
  try {
    project = await loadProject(id);
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  if (!project) return { ok: false, message: "Project not found" };

  // GPT sees the reference images, so the cast it writes matches them.
  const images: string[] = [];
  for (const ref of project.references) {
    if (!VISION_IMAGE_TYPES.includes(ref.contentType)) continue;
    const bytes = await readStored(ref.filePath);
    if (!bytes || bytes.byteLength > VISION_MAX_IMAGE_BYTES) continue;
    images.push(`data:${ref.contentType};base64,${Buffer.from(bytes).toString("base64")}`);
  }

  const aspectRatio = (LAB_ASPECT_RATIOS as readonly string[]).includes(project.aspectRatio)
    ? (project.aspectRatio as (typeof LAB_ASPECT_RATIOS)[number])
    : "9:16";
  const prompt = buildLabStoryPrompt({ topic: project.topic, aspectRatio, referenceCount: images.length });
  const config = getOpenAIConfig();
  const result = await runOpenAIStructuredGeneration(
    { apiKey },
    {
      ...prompt,
      model: config.model,
      effort: config.effort,
      maxOutputTokens: 16_000,
      subject: "story",
      name: "adult_lab_story",
      refusalHint: "Try rewording the topic.",
      images,
    },
    labStoryOutputSchema,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const story = storyFromOutput(result.data);
  if (!story.scenes.length) return { ok: false, message: "GPT returned a story without scenes. Try again." };

  try {
    await db
      .update(labProjects)
      .set({ story, storyVersion: project.storyVersion + 1, approved: false, updatedAt: new Date() })
      .where(eq(labProjects.id, id));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: `Story ready: ${story.scenes.length} scenes. Edit it, then approve.` };
}

/** Saves the edited story. Editing an approved story keeps it approved; the user decides when to re-approve. */
export async function saveLabStory(id: string, story: LabStory): Promise<ActionResult> {
  const parsed = labStorySchema.safeParse(story);
  if (!parsed.success) return { ok: false, message: `Story not saved: ${parsed.error.issues[0].message}` };
  try {
    const project = await loadProject(id);
    if (!project) return { ok: false, message: "Project not found" };
    await db.update(labProjects).set({ story: parsed.data, updatedAt: new Date() }).where(eq(labProjects.id, id));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: "Story saved" };
}

export async function setLabApproved(id: string, approved: boolean): Promise<ActionResult> {
  try {
    const project = await loadProject(id);
    if (!project) return { ok: false, message: "Project not found" };
    if (approved && !project.story) return { ok: false, message: "Generate a story first" };
    await db.update(labProjects).set({ approved, updatedAt: new Date() }).where(eq(labProjects.id, id));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: approved ? "Story approved. You can generate images and clips now." : "Back to draft" };
}

export async function removeLabReference(id: string, referenceId: string): Promise<ActionResult> {
  try {
    const project = await loadProject(id);
    if (!project) return { ok: false, message: "Project not found" };
    const ref = project.references.find((r) => r.id === referenceId);
    if (!ref) return { ok: false, message: "Reference not found" };
    await db
      .update(labProjects)
      .set({ references: project.references.filter((r) => r.id !== referenceId), updatedAt: new Date() })
      .where(eq(labProjects.id, id));
    const full = resolveMediaPath(ref.filePath);
    if (full) await unlink(full).catch(() => undefined);
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: "Reference removed" };
}

export async function deleteLabProject(id: string): Promise<ActionResult> {
  try {
    const project = await loadProject(id);
    if (!project) return { ok: false, message: "Project not found" };
    await db.delete(labProjects).where(eq(labProjects.id, id));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: "Project deleted" };
}

type Provider = {
  label: string;
  upload: (bytes: Uint8Array, contentType: string) => Promise<string>;
  estimate: (body: Record<string, unknown>) => Promise<number | null>;
  submit: (body: Record<string, unknown>) => Promise<{ requestId: string; running: boolean }>;
};

function getProvider(model: HiggsfieldModel): Provider | { error: string } {
  if (model.provider === REPLICATE_PROVIDER) {
    const replicate = getReplicateClient();
    if (!replicate) return { error: REPLICATE_NOT_CONFIGURED_MESSAGE };
    return {
      label: "Replicate",
      upload: (bytes, type) => replicate.uploadFile(bytes, type),
      estimate: async (body) => estimateReplicateCost(model, body),
      submit: async (body) => {
        const prediction = await replicate.createPrediction(model.path, body);
        return { requestId: prediction.id, running: prediction.status === "processing" };
      },
    };
  }
  const higgsfield = getHiggsfieldClient();
  if (!higgsfield) return { error: HIGGSFIELD_NOT_CONFIGURED };
  return {
    label: "Higgsfield",
    upload: (bytes, type) => higgsfield.uploadFile(bytes, type),
    estimate: (body) => higgsfield.estimate(model.path, body),
    submit: async (body) => {
      const response = await higgsfield.submit(model.path, body, randomUUID());
      return { requestId: response.request_id, running: response.status === "in_progress" };
    },
  };
}

type Prepared = { project: LabProject; story: LabStory; scene: LabStory["scenes"][number] };

async function prepareScene(projectId: string, sceneId: string): Promise<Prepared | { error: string }> {
  let project: LabProject | null;
  try {
    project = await loadProject(projectId);
  } catch {
    return { error: DB_ERROR };
  }
  if (!project) return { error: "Project not found" };
  if (!project.story) return { error: "Generate a story first" };
  if (!project.approved) return { error: "Approve the story before generating" };
  const scene = project.story.scenes.find((s) => s.id === sceneId);
  if (!scene) return { error: "Scene not found. Save the story first." };
  return { project, story: project.story, scene };
}

/** Uploads stored images to the provider in order; Kling inputs are checked against its rules first. */
async function uploadImages(provider: Provider, images: { filePath: string; contentType: string; role: string }[], kling: boolean) {
  const urls: string[] = [];
  for (const image of images) {
    const bytes = await readStored(image.filePath);
    if (!bytes) throw new MediaError(`The ${image.role} file is missing from storage`);
    if (kling) {
      const problem = checkKlingImage(
        { contentType: image.contentType, sizeBytes: bytes.byteLength, size: readImageSize(bytes) },
        image.role,
      );
      if (problem) throw new MediaError(problem);
    }
    urls.push(await provider.upload(bytes, image.contentType));
  }
  return urls;
}

async function submitJob(
  prepared: Prepared,
  model: HiggsfieldModel,
  provider: Provider,
  prompt: string,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  const estimate = await provider.estimate(body);
  let jobId: string;
  try {
    const [job] = await db
      .insert(labJobs)
      .values({
        projectId: prepared.project.id,
        sceneId: prepared.scene.id,
        kind: model.output,
        provider: model.provider ?? "higgsfield",
        model: model.id,
        status: "queued",
        prompt,
        request: body,
        estimatedCostUsd: estimate === null ? null : String(estimate),
      })
      .returning({ id: labJobs.id });
    jobId = job.id;
  } catch {
    return { ok: false, message: DB_ERROR };
  }

  try {
    const response = await provider.submit(body);
    await db
      .update(labJobs)
      .set({ externalRequestId: response.requestId, status: response.running ? "in_progress" : "queued", submittedAt: new Date() })
      .where(eq(labJobs.id, jobId));
    revalidate();
    const cost = estimate === null ? "" : ` (~$${estimate.toFixed(2)})`;
    return { ok: true, message: `Submitted to ${provider.label}${cost}. It updates automatically.` };
  } catch (error) {
    const message = providerMessage(error, `Submitting to ${provider.label} failed`);
    await db.update(labJobs).set({ status: "failed", error: message, completedAt: new Date() }).where(eq(labJobs.id, jobId));
    revalidate();
    return { ok: false, message };
  }
}

/** Grok Image 2.0 keyframe for a scene, with the project's reference images attached. */
export async function generateLabImage(projectId: string, sceneId: string): Promise<ActionResult> {
  const prepared = await prepareScene(projectId, sceneId);
  if ("error" in prepared) return { ok: false, message: prepared.error };
  if (!prepared.scene.imagePrompt.trim()) return { ok: false, message: "Add an image prompt to the scene first" };
  const model = getHiggsfieldModel(LAB_IMAGE_MODEL)!;
  const provider = getProvider(model);
  if ("error" in provider) return { ok: false, message: provider.error };

  const refs = prepared.project.references.slice(0, model.maxReferenceImages ?? 0);
  let referenceUrls: string[];
  try {
    referenceUrls = await uploadImages(
      provider,
      refs.map((r, i) => ({ ...r, role: `reference image ${i + 1}` })),
      false,
    );
  } catch (error) {
    return { ok: false, message: providerMessage(error, "Could not upload the reference images") };
  }
  const prompt = buildLabImagePrompt(prepared.story, prepared.scene, referenceUrls.length);
  const body = buildRequestBody(model, {
    prompt,
    aspectRatio: prepared.project.aspectRatio as (typeof LAB_ASPECT_RATIOS)[number],
    durationSeconds: prepared.scene.durationSeconds,
    referenceUrls,
  });
  return submitJob(prepared, model, provider, prompt, body);
}

/**
 * Kling 4.0 clip for a scene. With a chosen start image it animates that frame; otherwise it sends the
 * project's reference images (or the prompt alone when there are none).
 */
export async function generateLabVideo(projectId: string, sceneId: string): Promise<ActionResult> {
  const prepared = await prepareScene(projectId, sceneId);
  if ("error" in prepared) return { ok: false, message: prepared.error };
  if (!prepared.scene.videoPrompt.trim()) return { ok: false, message: "Add a video prompt to the scene first" };

  let start: LabJob | undefined;
  if (prepared.scene.startImageJobId) {
    [start] = await db
      .select()
      .from(labJobs)
      .where(and(eq(labJobs.id, prepared.scene.startImageJobId), eq(labJobs.projectId, projectId)));
    if (!start?.filePath || !start.contentType || start.kind !== "image") {
      return { ok: false, message: "The chosen start image is gone. Pick another one or clear it." };
    }
  }
  const references = prepared.project.references;
  const mode: LabVideoMode = start ? "startImage" : references.length ? "references" : "text";
  const model = getHiggsfieldModel(LAB_VIDEO_MODELS[mode])!;
  const provider = getProvider(model);
  if ("error" in provider) return { ok: false, message: provider.error };

  let imageUrl: string | undefined;
  let referenceUrls: string[] | undefined;
  try {
    if (start) {
      [imageUrl] = await uploadImages(provider, [{ filePath: start.filePath!, contentType: start.contentType!, role: "start image" }], true);
    } else if (references.length) {
      referenceUrls = await uploadImages(
        provider,
        references.slice(0, model.maxReferenceImages ?? 0).map((r, i) => ({ ...r, role: `reference image ${i + 1}` })),
        true,
      );
    }
  } catch (error) {
    return { ok: false, message: providerMessage(error, "Could not upload the images") };
  }

  const prompt = buildLabVideoPrompt(prepared.story, prepared.scene, mode, referenceUrls?.length ?? 0);
  const body = buildRequestBody(model, {
    prompt,
    aspectRatio: prepared.project.aspectRatio as (typeof LAB_ASPECT_RATIOS)[number],
    durationSeconds: prepared.scene.durationSeconds,
    imageUrl,
    referenceUrls,
  });
  return submitJob(prepared, model, provider, prompt, body);
}

function statusReader(provider: string) {
  if (provider === REPLICATE_PROVIDER) {
    const replicate = getReplicateClient();
    return replicate && (async (id: string) => replicateToRemoteStatus(await replicate.getPrediction(id)));
  }
  const higgsfield = getHiggsfieldClient();
  return higgsfield && ((id: string) => higgsfield.getStatus(id));
}

/**
 * Reads one job's remote status and records the result. A recheck (of a timed-out job) ignores the
 * timeout; if the provider is still working, the job goes back to polling with a fresh timeout window.
 */
async function applyRemoteStatus(job: LabJob, recheck: boolean): Promise<{ changed: boolean; message?: string }> {
  if (!job.externalRequestId) return { changed: false, message: "This job never reached the provider. Generate again." };
  const read = statusReader(job.provider);
  if (!read) return { changed: false, message: job.provider === REPLICATE_PROVIDER ? REPLICATE_NOT_CONFIGURED_MESSAGE : HIGGSFIELD_NOT_CONFIGURED };
  let remote;
  try {
    remote = await read(job.externalRequestId);
  } catch (error) {
    return { changed: false, message: providerMessage(error, "Status check failed") }; // transient; polling tries again
  }
  const label = job.provider === REPLICATE_PROVIDER ? "Replicate" : "Higgsfield";
  const timeoutMs = recheck ? Infinity : JOB_TIMEOUT_MS;
  const update = interpretRemoteStatus(remote, { submittedAt: job.submittedAt, outputKind: job.kind }, new Date(), timeoutMs, label);
  if (!update.terminal) {
    if (recheck) {
      await db
        .update(labJobs)
        .set({ status: update.status as LabJob["status"], error: null, submittedAt: new Date() })
        .where(eq(labJobs.id, job.id));
      return { changed: true, message: `${label} is still working on it. Polling resumed.` };
    }
    if (update.status !== job.status) {
      await db.update(labJobs).set({ status: update.status as LabJob["status"] }).where(eq(labJobs.id, job.id));
      return { changed: true };
    }
    return { changed: false };
  }

  // Image models can return several files; the first becomes this job's output, extras get their own rows.
  const saved = [];
  let downloadError: string | null = null;
  for (const output of update.outputs) {
    try {
      saved.push({ url: output.url, file: await downloadMedia(output.url, `lab/${job.projectId}`) });
    } catch (error) {
      downloadError = error instanceof MediaError ? error.message : "Download failed";
    }
  }
  const [first, ...extra] = saved;
  await db
    .update(labJobs)
    .set({
      status: update.status as LabJob["status"],
      error: update.error ?? (first ? null : downloadError),
      completedAt: new Date(),
      filePath: first?.file.filePath ?? null,
      contentType: first?.file.contentType ?? null,
      sourceUrl: first?.url ?? update.outputs[0]?.url ?? null,
    })
    .where(eq(labJobs.id, job.id));
  for (const output of extra) {
    await db.insert(labJobs).values({
      projectId: job.projectId,
      sceneId: job.sceneId,
      kind: job.kind,
      provider: job.provider,
      model: job.model,
      status: "completed",
      prompt: job.prompt,
      request: job.request,
      externalRequestId: job.externalRequestId,
      filePath: output.file.filePath,
      contentType: output.file.contentType,
      sourceUrl: output.url,
      submittedAt: job.submittedAt,
      completedAt: new Date(),
    });
  }
  return { changed: true, message: update.status === "completed" ? "Finished. Output saved." : (update.error ?? "Job ended") };
}

/** Polls the project's running jobs and stores finished outputs locally (provider URLs expire). */
export async function refreshLabJobs(projectId: string): Promise<{ changed: boolean; active: number }> {
  if (!idSchema.safeParse(projectId).success) return { changed: false, active: 0 };
  const jobs = await db
    .select()
    .from(labJobs)
    .where(and(eq(labJobs.projectId, projectId), inArray(labJobs.status, [...LAB_ACTIVE_STATUSES])));

  let changed = false;
  for (const job of jobs) {
    if ((await applyRemoteStatus(job, false)).changed) changed = true;
  }
  if (changed) revalidate();
  return { changed, active: jobs.length };
}

/** Asks the provider again about a timed-out job. Costs nothing; it does not resubmit. */
export async function recheckLabJob(jobId: string): Promise<ActionResult> {
  if (!idSchema.safeParse(jobId).success) return { ok: false, message: "Not found" };
  let job: LabJob | undefined;
  try {
    [job] = await db.select().from(labJobs).where(eq(labJobs.id, jobId));
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  if (!job) return { ok: false, message: "Not found" };
  if (job.status !== "timed_out") return { ok: false, message: "Only timed-out jobs can be checked again" };
  const result = await applyRemoteStatus(job, true);
  if (result.changed) revalidate();
  return { ok: result.changed, message: result.message ?? "No change yet" };
}

export async function deleteLabJob(jobId: string): Promise<ActionResult> {
  if (!idSchema.safeParse(jobId).success) return { ok: false, message: "Not found" };
  try {
    const [job] = await db.delete(labJobs).where(eq(labJobs.id, jobId)).returning();
    if (job?.filePath) {
      const full = resolveMediaPath(job.filePath);
      if (full) await unlink(full).catch(() => undefined);
    }
  } catch {
    return { ok: false, message: DB_ERROR };
  }
  revalidate();
  return { ok: true, message: "Deleted" };
}

