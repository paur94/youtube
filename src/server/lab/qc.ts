import "server-only";

import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { type LabJob, type LabProject, labJobs, labProjects } from "@/db/schema";
import { gateBlocker, type GateReview, previousReviewLines, reviewChecks } from "@/lib/generation-qc";
import { LAB_VIDEO_MODELS, labSendsEndFrame } from "@/lib/lab";
import {
  buildLabGateInput,
  evaluateLabGate,
  type LabClipReport,
  labClipReviewSchema,
  labFinalPrompt,
  labGateReviewOutputSchema,
  labGateRules,
  labSceneClips,
  labVideoMode,
  type LabQcState,
  type LabSceneQc,
  readLabSceneQc,
} from "@/lib/lab-qc";
import { getHiggsfieldModel } from "@/lib/higgsfield";
import { parseTimeline } from "@/lib/production";
import { pickFrameTimes, type ShotSpec } from "@/lib/story-qc";
import { buildGateReviewText, buildLabClipText, gateReviewSystemPrompt, LAB_CLIP_SYSTEM_PROMPT } from "@/server/ai/gate-prompt";
import { getOpenAIConfig, OPENAI_NOT_CONFIGURED_MESSAGE, runOpenAIStructuredGeneration } from "@/server/ai/openai";
import { downscaleImage, extractFrames, extractLastFrame, FfmpegError, getFfmpegVersion, probeMedia } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";

// Pre-generation QC and clip inspection for the Adult Lab (see @/lib/lab-qc). Runs on OpenAI like the
// rest of the lab, so it needs no other key.

export type LabQcResult = { ok: boolean; message: string };

const MAX_REFERENCES = 4;
const MAX_FRAMES = 8;
const RAW_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const RAW_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export async function loadLabProject(projectId: string) {
  const [project] = await db.select().from(labProjects).where(eq(labProjects.id, projectId));
  if (!project) return null;
  const jobs = await db.select().from(labJobs).where(eq(labJobs.projectId, projectId));
  return { project, jobs };
}

export function labGateFor(project: LabProject, jobs: LabJob[], sceneId: string) {
  if (!project.story) return null;
  const input = buildLabGateInput({
    story: project.story,
    sceneId,
    references: project.references,
    aspectRatio: project.aspectRatio,
    qc: project.qc,
    jobs,
    aiConfigured: getOpenAIConfig().configured,
  });
  return input ? { input, evaluation: evaluateLabGate(input) } : null;
}

/** Why the scene's clip can't be generated yet, or null. generateLabVideo calls this before paying. */
export function labVideoGateBlocker(project: LabProject, jobs: LabJob[], sceneId: string) {
  const gate = labGateFor(project, jobs, sceneId);
  if (!gate) return "Scene not found. Save the story first.";
  return gateBlocker(gate.evaluation);
}

/** Read-modify-write of one scene's QC record, locked so parallel clicks don't overwrite each other. */
async function updateSceneQc(projectId: string, sceneId: string, change: (qc: LabSceneQc) => LabSceneQc) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ qc: labProjects.qc }).from(labProjects).where(eq(labProjects.id, projectId)).for("update");
    if (!row) return;
    const state: LabQcState = { scenes: { ...(row.qc?.scenes ?? {}) } };
    state.scenes[sceneId] = change(readLabSceneQc(row.qc, sceneId));
    await tx.update(labProjects).set({ qc: state }).where(eq(labProjects.id, projectId));
  });
}

/** A stored image as a data URL for vision input: a small JPEG with FFmpeg, else the original when acceptable. */
async function imageDataUrl(filePath: string, contentType: string | null, ffmpeg: boolean) {
  try {
    if (ffmpeg) return `data:image/jpeg;base64,${(await downscaleImage(filePath, 768)).toString("base64")}`;
    const full = resolveMediaPath(filePath);
    if (!full || !contentType || !RAW_IMAGE_TYPES.includes(contentType)) return null;
    const bytes = await readFile(full);
    return bytes.byteLength > RAW_IMAGE_MAX_BYTES ? null : `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

const isReviewRule = (label: string) => label.startsWith("AI review");

/**
 * One OpenAI vision call before a lab clip is paid for: the start frame (or the references Kling gets),
 * the cast, the exact Kling prompt and the rule findings. Refuses without calling OpenAI while a hard
 * rule problem would change the request anyway.
 */
export async function runLabSceneReview(projectId: string, sceneId: string): Promise<LabQcResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { ok: false, message: OPENAI_NOT_CONFIGURED_MESSAGE };
  const loaded = await loadLabProject(projectId);
  if (!loaded?.project.story) return { ok: false, message: "Generate a story first" };
  const { project, jobs } = loaded;
  const gate = labGateFor(project, jobs, sceneId);
  if (!gate) return { ok: false, message: "Scene not found. Save the story first." };
  const { input } = gate;
  const story = project.story!;
  const scene = input.scene;

  const hard = labGateRules(input).filter((c) => c.hard && c.status === "critical" && !isReviewRule(c.label));
  if (hard.length) return { ok: false, message: `Fix this first (no review was run, so nothing was charged): ${hard[0].label}. ${hard[0].fix ?? hard[0].detail}` };

  const ffmpeg = Boolean(await getFfmpegVersion());
  const mode = labVideoMode(scene, project.references.length);
  const model = getHiggsfieldModel(LAB_VIDEO_MODELS[mode])!;
  const images: string[] = [];
  const legend: string[] = [];
  if (mode === "startImage") {
    const start = jobs.find((j) => j.id === scene.startImageJobId);
    const url = start?.filePath ? await imageDataUrl(start.filePath, start.contentType, ffmpeg) : null;
    if (url) {
      images.push(url);
      legend.push(`Image ${images.length}: START frame (@image_1, the first frame of the clip)${start?.model === "last-frame" ? ", taken from the previous clip's last frame" : ""}`);
    }
    const end = labSendsEndFrame(scene) ? jobs.find((j) => j.id === scene.endImageJobId) : undefined;
    const endUrl = end?.filePath ? await imageDataUrl(end.filePath, end.contentType, ffmpeg) : null;
    if (endUrl) {
      images.push(endUrl);
      legend.push(`Image ${images.length}: END frame (@image_2, the last frame of the clip)`);
    }
  }
  // A scene that doesn't start on the previous clip's last frame is still compared with it for continuity.
  const startsOnLastFrame = jobs.find((j) => j.id === scene.startImageJobId)?.model === "last-frame";
  const previousClip = input.index > 0 && !startsOnLastFrame ? labSceneClips(jobs, story.scenes[input.index - 1].id).at(-1) : undefined;
  if (previousClip?.job.filePath && ffmpeg) {
    const png = await extractLastFrame(previousClip.job.filePath).catch(() => null);
    if (png) {
      images.push(`data:image/png;base64,${png.toString("base64")}`);
      legend.push(`Image ${images.length}: LAST frame of the previous scene's clip (not sent to Kling; this scene must logically continue from it)`);
    }
  }
  const refs = project.references.slice(0, Math.min(MAX_REFERENCES, model.maxReferenceImages ?? MAX_REFERENCES));
  for (const [i, ref] of refs.entries()) {
    const url = await imageDataUrl(ref.filePath, ref.contentType, ffmpeg);
    if (!url) continue;
    images.push(url);
    legend.push(
      `Image ${images.length}: reference "${ref.name}"${mode === "references" ? ` (sent to Kling as @image_${i + 1})` : " (used for the story and the start frame; not sent with this clip)"}`,
    );
  }
  const prompt = labFinalPrompt(story, scene, project.references.length);
  const previous = input.index > 0 ? story.scenes[input.index - 1] : null;
  const lastClip = labSceneClips(jobs, scene.id).at(-1);
  const lastReport = lastClip?.job.qc as LabClipReport | null | undefined;

  const text = buildGateReviewText({
    title: `Scene ${input.index + 1}: ${scene.title}`,
    model: `${model.label} (${mode === "startImage" ? "animates the start frame" : mode === "references" ? "reference images" : "text only"}, ${project.aspectRatio})`,
    clipSeconds: scene.durationSeconds,
    sceneSeconds: scene.durationSeconds,
    frameLegend: legend,
    sceneLines: [
      `Story: ${story.title}. ${story.logline}`,
      `Brief of the whole story (context; this clip only has to deliver its own motion prompt): ${project.topic}`,
      `Cast: ${story.characters.map((c) => `${c.name}: ${c.look}`).join(" | ") || "(none)"}`,
      `Image prompt (the scene's keyframe): ${scene.imagePrompt || "(none)"}`,
      `Motion prompt: ${scene.videoPrompt || "(none)"}`,
      `Dialogue:\n${scene.dialogue || "(none)"}`,
      ...(previous ? [`Previous scene (${previous.durationSeconds}s), which this one follows:
${previous.videoPrompt.slice(0, 2500)}`] : []),
    ],
    prompt,
    ruleFindings: labGateRules(input),
    history: lastReport?.issues?.length
      ? lastReport.issues.map((i) => `- Clip ${lastClip!.revision}${i.timestamp != null ? ` at ${i.timestamp}s` : ""} [${i.severity}]: ${i.label}. ${i.observed} Fix: ${i.fix}`)
      : [],
    previousReview: previousReviewLines(input.qc.review, scene.videoPrompt),
  });

  const config = getOpenAIConfig();
  const result = await runOpenAIStructuredGeneration(
    { apiKey },
    {
      system: gateReviewSystemPrompt("adult"),
      user: text,
      images,
      model: config.model,
      effort: config.effort,
      maxOutputTokens: 16_000,
      subject: "pre-generation review",
      name: "pre_generation_review",
    },
    labGateReviewOutputSchema,
  );
  if (!result.ok) return { ok: false, message: result.message };

  const review: GateReview = {
    contentKey: input.contentKey,
    modelId: null,
    startAssetId: scene.startImageJobId,
    checkedAt: new Date().toISOString(),
    model: result.model,
    frames: result.data.frames,
    beats: result.data.beats,
    checks: reviewChecks(result.data, scene.durationSeconds),
    fit: result.data.fit,
    reviewedText: scene.videoPrompt,
    // An over-full scene needs a split, not a rewrite: a trimmed prompt would only be flagged next round.
    promptAdditions: result.data.fit.fits ? result.data.promptAdditions.trim() : "",
    suggestedPrompt: result.data.fit.fits ? result.data.suggestedPrompt.trim() : "",
    suggestedImagePrompt: result.data.suggestedImagePrompt.trim(),
    summary: result.data.summary.trim(),
  };
  await updateSceneQc(projectId, sceneId, (qc) => ({
    ...qc,
    review,
    approval: qc.approval && qc.approval.contentKey === review.contentKey ? qc.approval : null,
  }));
  const critical = review.checks.filter((c) => c.status === "critical").length;
  const warnings = review.checks.filter((c) => c.status === "warning").length;
  return {
    ok: true,
    message: critical
      ? `Review found ${critical} critical issue${critical === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}. Fix them before generating.`
      : `Review passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}. Check the report, then approve.`,
  };
}

export async function setLabSceneApproval(projectId: string, sceneId: string, approve: boolean): Promise<LabQcResult> {
  const loaded = await loadLabProject(projectId);
  if (!loaded?.project.story) return { ok: false, message: "Generate a story first" };
  if (!approve) {
    await updateSceneQc(projectId, sceneId, (qc) => ({ ...qc, approval: null }));
    return { ok: true, message: "Approval withdrawn" };
  }
  const gate = labGateFor(loaded.project, loaded.jobs, sceneId);
  if (!gate) return { ok: false, message: "Scene not found. Save the story first." };
  if (!gate.evaluation.canApprove) return { ok: false, message: gateBlocker(gate.evaluation) ?? "Resolve the critical issues first" };
  const approval = { contentKey: gate.input.contentKey, modelId: null, startAssetId: gate.input.scene.startImageJobId, approvedAt: new Date().toISOString() };
  await updateSceneQc(projectId, sceneId, (qc) => ({ ...qc, approval }));
  return { ok: true, message: "Version approved. You can generate the clip; any edit needs a new review and approval." };
}

/**
 * The person checked the open critical issues and accepts them: marks every dismissible one OK and approves
 * this exact version in one step. Hard issues (provider would reject, review missing or stale) still block.
 */
export async function acceptLabSceneIssues(projectId: string, sceneId: string): Promise<LabQcResult> {
  const loaded = await loadLabProject(projectId);
  if (!loaded?.project.story) return { ok: false, message: "Generate a story first" };
  if (!loaded.project.approved) return { ok: false, message: "Approve the story first" };
  const gate = labGateFor(loaded.project, loaded.jobs, sceneId);
  if (!gate) return { ok: false, message: "Scene not found. Save the story first." };
  const hard = gate.evaluation.critical.find((c) => c.hard);
  if (hard) return { ok: false, message: `Can't be marked OK: ${hard.label}. ${hard.fix ?? hard.detail}` };
  const ids = gate.evaluation.critical.map((c) => c.id);
  const approval = { contentKey: gate.input.contentKey, modelId: null, startAssetId: gate.input.scene.startImageJobId, approvedAt: new Date().toISOString() };
  await updateSceneQc(projectId, sceneId, (qc) => ({ ...qc, dismissed: [...new Set([...qc.dismissed, ...ids])], approval }));
  return {
    ok: true,
    message: ids.length ? `Marked ${ids.length} critical issue${ids.length === 1 ? "" : "s"} OK and approved this version.` : "Version approved.",
  };
}

export async function setLabCheckDismissed(projectId: string, sceneId: string, checkId: string, dismissed: boolean): Promise<LabQcResult> {
  const loaded = await loadLabProject(projectId);
  if (!loaded) return { ok: false, message: "Project not found" };
  await updateSceneQc(projectId, sceneId, (qc) => ({
    ...qc,
    dismissed: dismissed ? [...new Set([...qc.dismissed, checkId])] : qc.dismissed.filter((d) => d !== checkId),
  }));
  return { ok: true, message: dismissed ? "Check dismissed" : "Check restored" };
}

/**
 * Post-generation inspection: frames across the finished clip (one per planned beat where known, plus the
 * opening and closing frames) compared with the prompt, timeline and references. Issues come back with
 * timestamps and a corrected prompt for the next attempt. Saved on the job.
 */
export async function runLabClipInspection(jobId: string): Promise<LabQcResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { ok: false, message: OPENAI_NOT_CONFIGURED_MESSAGE };
  const [job] = await db.select().from(labJobs).where(eq(labJobs.id, jobId));
  if (!job) return { ok: false, message: "Clip not found" };
  if (job.kind !== "video" || job.status !== "completed" || !job.filePath) return { ok: false, message: "Only finished clips can be inspected" };
  if (!(await getFfmpegVersion())) return { ok: false, message: "FFmpeg is needed to extract frames from the clip. Install it or set FFMPEG_PATH." };
  const loaded = await loadLabProject(job.projectId);
  const story = loaded?.project.story;
  if (!loaded || !story) return { ok: false, message: "Project not found" };
  const gate = labGateFor(loaded.project, loaded.jobs, job.sceneId);
  if (!gate) return { ok: false, message: "The clip's scene is gone from the story" };
  const scene = gate.input.scene;

  // The planned timeline: the current review's beats, else the timed beats in the prompt that was sent.
  const review = gate.evaluation.review ?? gate.input.qc.review;
  const beats = review?.beats.length
    ? review.beats.map((b) => ({ start: b.startSeconds, end: b.endSeconds, text: b.action }))
    : parseTimeline(job.prompt).segments;

  let frames: { time: number; jpeg: Buffer }[];
  let duration: number;
  try {
    duration = (await probeMedia(job.filePath)).durationSeconds ?? scene.durationSeconds;
    const shots = beats.map((b) => ({ startSeconds: b.start, endSeconds: b.end }) as ShotSpec);
    const times = [...new Set([...pickFrameTimes(duration, shots, MAX_FRAMES - 1), Math.max(0, Math.round((duration - 0.2) * 10) / 10)])].sort((a, b) => a - b);
    frames = await extractFrames(job.filePath, times, 640);
  } catch (error) {
    return { ok: false, message: error instanceof FfmpegError ? error.message : "Could not read frames from the clip" };
  }

  const images: string[] = [];
  const referenceLabels: string[] = [];
  const start = scene.startImageJobId ? loaded.jobs.find((j) => j.id === scene.startImageJobId) : undefined;
  if (start?.filePath) {
    const url = await imageDataUrl(start.filePath, start.contentType, true);
    if (url) {
      images.push(url);
      referenceLabels.push(`image ${images.length}: start frame`);
    }
  }
  const end = labSendsEndFrame(scene) ? loaded.jobs.find((j) => j.id === scene.endImageJobId) : undefined;
  if (end?.filePath) {
    const url = await imageDataUrl(end.filePath, end.contentType, true);
    if (url) {
      images.push(url);
      referenceLabels.push(`image ${images.length}: end frame the clip was asked to finish on`);
    }
  }
  for (const ref of loaded.project.references.slice(0, 3)) {
    const url = await imageDataUrl(ref.filePath, ref.contentType, true);
    if (!url) continue;
    images.push(url);
    referenceLabels.push(`image ${images.length}: reference "${ref.name}"`);
  }
  for (const f of frames) images.push(`data:image/jpeg;base64,${f.jpeg.toString("base64")}`);

  const config = getOpenAIConfig();
  const result = await runOpenAIStructuredGeneration(
    { apiKey },
    {
      system: LAB_CLIP_SYSTEM_PROMPT,
      user: buildLabClipText({
        frameTimes: frames.map((f) => f.time),
        durationSeconds: Math.round(duration * 10) / 10,
        prompt: job.prompt,
        dialogue: scene.dialogue,
        beats: beats.map((b) => `${b.start}-${b.end}s: ${b.text}`),
        referenceLabels: [...referenceLabels, `then ${frames.length} clip frames in time order`],
      }),
      images,
      model: config.model,
      effort: config.effort,
      maxOutputTokens: 12_000,
      subject: "clip inspection",
      name: "clip_inspection",
    },
    labClipReviewSchema,
  );
  if (!result.ok) return { ok: false, message: result.message };

  const report: LabClipReport = {
    ...result.data,
    summary: result.data.summary.trim(),
    suggestedPrompt: result.data.suggestedPrompt.trim(),
    contentKey: gate.input.contentKey,
    checkedAt: new Date().toISOString(),
    model: result.model,
  };
  await db.update(labJobs).set({ qc: report }).where(eq(labJobs.id, job.id));
  const critical = report.issues.filter((i) => i.severity === "critical").length;
  return {
    ok: true,
    message: critical
      ? `Inspected: ${critical} critical mistake${critical === 1 ? "" : "s"}. Apply the suggested prompt before generating again.`
      : report.issues.length
        ? "Inspected: minor issues only. Review them."
        : "Inspected: the clip matches the request.",
  };
}
