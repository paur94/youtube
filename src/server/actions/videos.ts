"use server";

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { assets, productionPlans, productionScenes, shortGenerations, shorts, type Video, videos } from "@/db/schema";
import {
  buildLandscapeAss,
  clipLength,
  computeTimeline,
  DEFAULT_EDIT_SETTINGS,
  editSettingsSchema,
  evaluateVideoQuality,
  isVideoLocked,
  MIN_CLIP_SECONDS,
  parseVideoMetadataForm,
  timelineCaptions,
  uploadDescription,
  type VideoClip,
  videoApprovalBlockers,
  videoMetadataSuggestionSchema,
  type VideoMetadataState,
  videoRenderKey,
  type VideoStatus,
} from "@/lib/long-video";
import { buildCaptionsFromDialogue, buildYouTubeMetadata, isPublishable, normalizeHashtags, parseCaptionLines, TITLE_MAX } from "@/lib/shorts";
import { getClaudeClient, getClaudeConfig, NOT_CONFIGURED_MESSAGE, runStructuredGeneration } from "@/server/ai/claude";
import { buildVideoMetadataPrompt } from "@/server/ai/video-prompt";
import { FfmpegError, getFfmpegVersion, measureLoudness, probeMedia, renderTimeline } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";
import { getYouTubeConfig, YouTubeError } from "@/server/providers/youtube";
import { buildVideoQualityInput, getVideo, getVideoPublishContext, isRenderRunning, isVideoRenderCurrent, RENDER_STALE_MS } from "@/server/queries/videos";
import { getYouTubeClient, getYouTubeConnection } from "@/server/youtube/connection";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.
// Like Shorts, nothing is uploaded or published automatically: publishVideoToYouTube runs only when
// the user confirms it, and only for a video they explicitly approved after watching the render.

const idSchema = z.uuid();

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";
const LOCKED = "Published or uploaded videos are locked. Mark it as not published on the Publishing page first to edit it.";
const NO_FFMPEG = "FFmpeg isn't installed. Install it or set FFMPEG_PATH and FFPROBE_PATH in .env.local, then restart.";

function revalidateVideos(id?: string) {
  revalidatePath("/videos");
  revalidatePath("/publishing");
  if (id) revalidatePath(`/videos/${id}`);
}

async function loadVideo(id: string) {
  const [row] = await db.select().from(videos).where(eq(videos.id, id));
  return row ?? null;
}

/** Editing a video that is in or past review sends it back to draft, so it is reviewed and approved again. */
function afterEdit(status: VideoStatus) {
  return status === "draft" || status === "rejected" ? {} : { status: "draft" as const, scheduledAt: null, publishError: null };
}

function guarded(name: string, fn: () => Promise<ActionResult>) {
  return fn().catch((error: unknown) => {
    console.error(`${name} failed`, error);
    return { ok: false as const, message: error instanceof FfmpegError ? error.message : DB_ERROR };
  });
}

// ---------- Clips ----------

type SceneClipRow = {
  sceneId: string;
  position: number;
  title: string;
  dialogue: { character: string; line: string }[];
  assetId: string;
  filePath: string;
  durationSeconds: string | null;
};

async function loadSceneClips(where: { planId?: string; assetIds?: string[] }): Promise<SceneClipRow[]> {
  const rows = await db
    .select({
      sceneId: productionScenes.id,
      position: productionScenes.position,
      title: productionScenes.title,
      dialogue: productionScenes.dialogue,
      assetId: assets.id,
      filePath: assets.filePath,
      durationSeconds: assets.durationSeconds,
    })
    .from(productionScenes)
    .innerJoin(assets, eq(productionScenes.selectedAssetId, assets.id))
    .where(
      and(
        eq(assets.kind, "video"),
        eq(assets.status, "approved"),
        where.planId ? eq(productionScenes.planId, where.planId) : undefined,
        where.assetIds ? inArray(assets.id, where.assetIds) : undefined,
      ),
    )
    .orderBy(productionScenes.position, productionScenes.createdAt);
  return rows.filter((r): r is SceneClipRow => Boolean(r.filePath));
}

/**
 * Snapshot of a scene clip for the timeline. Captions come from the scene's Short when its
 * captions were checked against the audio, otherwise they are estimated from the dialogue.
 */
async function snapshotClip(row: SceneClipRow, ffmpeg: boolean): Promise<VideoClip> {
  const probe = ffmpeg ? await probeMedia(row.filePath).catch(() => null) : null;
  const sourceSeconds = probe?.durationSeconds ?? (row.durationSeconds ? Number(row.durationSeconds) : 0);
  const [short] = await db
    .select({ captions: shorts.captions })
    .from(shorts)
    .where(and(eq(shorts.sourceAssetId, row.assetId), eq(shorts.captionsReviewed, true)))
    .limit(1);
  return {
    assetId: row.assetId,
    sceneId: row.sceneId,
    sceneNumber: row.position + 1,
    title: row.title,
    filePath: row.filePath,
    sourceSeconds,
    width: probe?.width ?? null,
    height: probe?.height ?? null,
    fps: probe?.fps ?? null,
    hasAudio: probe?.hasAudio ?? false,
    trimStart: 0,
    trimEnd: null,
    captions: short?.captions ?? buildCaptionsFromDialogue(row.dialogue, sourceSeconds),
  };
}

export type CreateVideoResult = ActionResult & { id?: string };

/** Creates a draft video from a plan's approved scene clips (all of them, or the chosen scenes). */
export async function createVideo(planId: string, sceneIds?: string[]): Promise<CreateVideoResult> {
  const id = idSchema.safeParse(planId);
  const scenes = z.array(idSchema).max(200).optional().safeParse(sceneIds);
  if (!id.success || !scenes.success) return { ok: false, message: "Invalid input" };
  try {
    const [plan] = await db.select().from(productionPlans).where(eq(productionPlans.id, id.data));
    if (!plan) return { ok: false, message: "Production plan not found" };
    let rows = await loadSceneClips({ planId: plan.id });
    if (scenes.data?.length) rows = rows.filter((r) => scenes.data!.includes(r.sceneId));
    if (!rows.length) return { ok: false, message: "None of the scenes has an approved final video on disk" };

    const ffmpeg = Boolean(await getFfmpegVersion());
    const clips = await Promise.all(rows.map((r) => snapshotClip(r, ffmpeg)));
    const [created] = await db
      .insert(videos)
      .values({ planId: plan.id, storyId: plan.storyId, title: plan.title.slice(0, TITLE_MAX), clips, editSettings: DEFAULT_EDIT_SETTINGS })
      .returning({ id: videos.id });
    revalidateVideos();
    return { ok: true, message: `Video created from ${clips.length} scene${clips.length === 1 ? "" : "s"}. Edit the timeline, then render it.`, id: created.id };
  } catch (error) {
    console.error("createVideo failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

/** Removes the video from the studio and deletes its renders. Scene clips and anything on YouTube stay. */
export async function deleteVideo(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("deleteVideo", async () => {
    renders.get(videoId.data)?.abort();
    const deleted = await db.delete(videos).where(eq(videos.id, videoId.data)).returning({ id: videos.id });
    if (!deleted.length) return { ok: false, message: "Video not found" };
    const folder = resolveMediaPath(`videos/${videoId.data}`);
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    revalidateVideos();
    return { ok: true, message: "Video removed. The scene clips are untouched, and anything already on YouTube stays there." };
  });
}

const clipEditSchema = z.object({
  assetId: idSchema,
  trimStart: z.number().min(0),
  trimEnd: z.number().positive().nullable(),
  /** Caption lines (`start-end | text`); null keeps the clip's current or generated captions. */
  captions: z.string().max(20_000).nullable(),
});

const editSchema = z.object({
  clips: z.array(clipEditSchema).max(200),
  settings: editSettingsSchema,
  captionsReviewed: z.boolean(),
});

export type VideoEditInput = z.input<typeof editSchema>;

/** Saves the timeline (order, trims, captions) and the edit settings in one go. */
export async function saveVideoEdit(id: string, input: VideoEditInput): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  const edit = editSchema.safeParse(input);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  if (!edit.success) return { ok: false, message: "Invalid timeline" };
  if (!edit.data.clips.length) return { ok: false, message: "Keep at least one clip on the timeline" };
  if (new Set(edit.data.clips.map((c) => c.assetId)).size !== edit.data.clips.length) return { ok: false, message: "Each clip can be used once" };

  return guarded("saveVideoEdit", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    if (isRenderRunning(video)) return { ok: false, message: "Wait for the render to finish, or cancel it, before editing." };

    const existing = new Map(video.clips.map((c) => [c.assetId, c]));
    const missing = edit.data.clips.filter((c) => !existing.has(c.assetId)).map((c) => c.assetId);
    if (missing.length) {
      if (!video.planId) return { ok: false, message: "The production plan was deleted, so no scenes can be added" };
      const rows = (await loadSceneClips({ planId: video.planId, assetIds: missing })).filter((r) => missing.includes(r.assetId));
      if (rows.length !== missing.length) return { ok: false, message: "A clip is no longer an approved scene video. Reload the page." };
      const ffmpeg = Boolean(await getFfmpegVersion());
      for (const row of rows) existing.set(row.assetId, await snapshotClip(row, ffmpeg));
    }

    const clips: VideoClip[] = [];
    for (const item of edit.data.clips) {
      const base = existing.get(item.assetId)!;
      const label = `Scene ${base.sceneNumber}`;
      const end = item.trimEnd === null || item.trimEnd >= base.sourceSeconds - 0.05 ? null : Math.round(item.trimEnd * 100) / 100;
      const clip = { ...base, trimStart: Math.round(item.trimStart * 100) / 100, trimEnd: end };
      if (clip.trimStart >= base.sourceSeconds) return { ok: false, message: `${label}: the start is after the clip ends (${base.sourceSeconds}s)` };
      if (end !== null && end <= clip.trimStart) return { ok: false, message: `${label}: the end must be after the start` };
      if (base.sourceSeconds && clipLength(clip) < MIN_CLIP_SECONDS) return { ok: false, message: `${label}: keep at least ${MIN_CLIP_SECONDS}s` };
      if (item.captions === null) {
        clips.push(clip);
        continue;
      }
      const { cues, errors } = parseCaptionLines(item.captions);
      if (errors.length) return { ok: false, message: `${label} captions: ${errors[0]}` };
      clips.push({ ...clip, captions: cues });
    }

    const changed =
      JSON.stringify(clips) !== JSON.stringify(video.clips) || JSON.stringify(edit.data.settings) !== JSON.stringify(video.editSettings);
    await db
      .update(videos)
      .set({ clips, editSettings: edit.data.settings, captionsReviewed: edit.data.captionsReviewed, ...(changed ? afterEdit(video.status) : {}) })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: changed ? "Edit saved. Render again to see it." : "Saved" };
  });
}

/** Swaps clips whose scene got a new final clip in the Production Studio for that clip. */
export async function switchToCurrentSceneClips(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("switchToCurrentSceneClips", async () => {
    const video = await loadVideo(videoId.data);
    if (!video?.planId) return { ok: false, message: "The production plan no longer exists" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    if (isRenderRunning(video)) return { ok: false, message: "Wait for the render to finish first" };
    const current = new Map((await loadSceneClips({ planId: video.planId })).map((r) => [r.sceneId, r]));
    const ffmpeg = Boolean(await getFfmpegVersion());
    let swapped = 0;
    const clips: VideoClip[] = [];
    for (const clip of video.clips) {
      const row = clip.sceneId ? current.get(clip.sceneId) : undefined;
      if (row && row.assetId !== clip.assetId) {
        clips.push(await snapshotClip(row, ffmpeg));
        swapped++;
      } else {
        clips.push(clip);
      }
    }
    if (!swapped) return { ok: true, message: "Every clip is already the scene's current final clip" };
    await db.update(videos).set({ clips, captionsReviewed: false, ...afterEdit(video.status) }).where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: `${swapped} clip${swapped === 1 ? "" : "s"} replaced. Check trims and captions, then render again.` };
  });
}

// ---------- FFmpeg ----------

// Renders run in the background of this (local) server process so a long render isn't cut off by
// a request timeout; the page polls for progress. Keyed by video id so a render can be cancelled.
const renders = new Map<string, AbortController>();

export async function renderVideo(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  if (!(await getFfmpegVersion())) return { ok: false, message: NO_FFMPEG };

  let video: Video | null;
  let startedAt: Date;
  try {
    video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    if (!video.clips.length) return { ok: false, message: "Add at least one clip first" };
    const tooShort = video.clips.find((c) => clipLength(c) < MIN_CLIP_SECONDS);
    if (tooShort) return { ok: false, message: `Scene ${tooShort.sceneNumber} is trimmed to under ${MIN_CLIP_SECONDS}s` };

    // Clips measured before FFmpeg was installed need their size, frame rate and sound track.
    const clips = await Promise.all(
      video.clips.map(async (c) => {
        if (c.width && c.sourceSeconds) return c;
        const probe = await probeMedia(c.filePath);
        if (!probe.width || !probe.durationSeconds) throw new FfmpegError(`Scene ${c.sceneNumber}'s clip has no readable video stream`);
        return { ...c, sourceSeconds: probe.durationSeconds, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio };
      }),
    );

    startedAt = new Date();
    const claim = await db
      .update(videos)
      .set({ clips, renderStartedAt: startedAt, renderProgress: 0, renderError: null })
      .where(
        and(
          eq(videos.id, video.id),
          or(isNull(videos.renderStartedAt), lt(videos.renderStartedAt, new Date(Date.now() - RENDER_STALE_MS))),
        ),
      )
      .returning();
    if (!claim.length) return { ok: false, message: "A render of this video is already running" };
    video = claim[0];
  } catch (error) {
    console.error("renderVideo failed", error);
    return { ok: false, message: error instanceof FfmpegError ? error.message : DB_ERROR };
  }

  const controller = new AbortController();
  renders.set(video.id, controller);
  void runRender(video, startedAt, controller.signal).finally(() => {
    if (renders.get(video.id) === controller) renders.delete(video.id);
  });
  revalidateVideos(video.id);
  return { ok: true, message: "Rendering started. You can leave this page; it keeps going." };
}

async function runRender(video: Video, startedAt: Date, signal: AbortSignal) {
  // Only touch the row while it still belongs to this render.
  const mine = and(eq(videos.id, video.id), eq(videos.renderStartedAt, startedAt));
  const settings = video.editSettings;
  const cues = settings.burnCaptions ? timelineCaptions(video.clips, computeTimeline(video.clips, settings)) : [];
  let lastReport = 0;
  try {
    const filePath = await renderTimeline({
      clips: video.clips,
      settings,
      folder: `videos/${video.id}`,
      fileName: `${randomUUID()}.mp4`,
      assSubtitles: cues.length ? buildLandscapeAss(cues) : null,
      signal,
      onProgress: (fraction) => {
        if (Date.now() - lastReport < 1500) return;
        lastReport = Date.now();
        void db.update(videos).set({ renderProgress: fraction }).where(mine).catch(() => undefined);
      },
    });
    const outputProbe = await probeMedia(filePath);
    const outputAudio = outputProbe.hasAudio ? await measureLoudness(filePath).catch(() => null) : null;
    const saved = await db
      .update(videos)
      .set({
        renderFilePath: filePath,
        renderKey: videoRenderKey(video.clips, settings),
        renderedAt: new Date(),
        renderError: null,
        renderStartedAt: null,
        renderProgress: null,
        outputProbe,
        outputAudio,
      })
      .where(mine)
      .returning({ id: videos.id });
    // Renders are derived files: drop the previous one once the new one is recorded.
    const previous = saved.length ? video.renderFilePath : filePath;
    const old = previous?.startsWith(`videos/${video.id}/`) ? resolveMediaPath(previous) : null;
    if (old) await rm(old, { force: true }).catch(() => undefined);
  } catch (error) {
    const message = signal.aborted ? "Render cancelled" : error instanceof FfmpegError ? error.message : "Rendering failed unexpectedly";
    if (!signal.aborted) console.error("renderVideo failed", error);
    await db
      .update(videos)
      .set({ renderError: message, renderStartedAt: null, renderProgress: null })
      .where(mine)
      .catch(() => undefined);
  }
}

export async function cancelVideoRender(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("cancelVideoRender", async () => {
    const running = renders.get(videoId.data);
    running?.abort();
    // Also clears a render left behind by a server restart.
    await db
      .update(videos)
      .set({ renderStartedAt: null, renderProgress: null, ...(running ? {} : { renderError: "Render stopped" }) })
      .where(eq(videos.id, videoId.data));
    revalidateVideos(videoId.data);
    return { ok: true, message: "Render cancelled" };
  });
}

// ---------- Metadata ----------

export async function updateVideoMetadata(id: string, _prev: VideoMetadataState, formData: FormData): Promise<VideoMetadataState> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  const parsed = parseVideoMetadataForm(formData);
  if (!parsed.success) return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  try {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    const d = parsed.data;
    const metadataChanged =
      d.title !== video.title || d.description !== video.description || d.hashtags.join(" ") !== video.hashtags.join(" ") || d.playlist !== video.playlist;
    await db
      .update(videos)
      .set({ ...d, ...(metadataChanged ? { metadataApprovedAt: null, ...afterEdit(video.status) } : {}) })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return {
      ok: true,
      message: metadataChanged
        ? video.metadataApprovedAt
          ? "Saved. The metadata changed, so approve it again."
          : "Saved. Approve the metadata when it's final."
        : "Saved",
    };
  } catch (error) {
    console.error("updateVideoMetadata failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export async function setVideoMetadataApproval(id: string, approved: boolean): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("setVideoMetadataApproval", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    if (approved && !video.title.trim()) return { ok: false, message: "Add a title first" };
    await db
      .update(videos)
      .set({ metadataApprovedAt: approved ? new Date() : null, ...(approved ? {} : afterEdit(video.status)) })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: approved ? "Metadata approved" : "Metadata approval removed" };
  });
}

/** Asks Claude for a title, description, hashtags and playlist, replacing the current ones. */
export async function suggestVideoMetadata(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  let video: Awaited<ReturnType<typeof getVideo>>;
  let sceneText: Map<string, { action: string; narration: string }>;
  try {
    video = await getVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    const sceneIds = video.clips.map((c) => c.sceneId).filter((s): s is string => Boolean(s));
    const rows = sceneIds.length
      ? await db
          .select({ id: productionScenes.id, action: productionScenes.action, narration: productionScenes.narration })
          .from(productionScenes)
          .where(inArray(productionScenes.id, sceneIds))
      : [];
    sceneText = new Map(rows.map((r) => [r.id, r]));
  } catch (error) {
    console.error("suggestVideoMetadata failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (isVideoLocked(video)) return { ok: false, message: LOCKED };

  const content = video.story?.content ?? null;
  const prompt = buildVideoMetadataPrompt({
    story:
      video.story && content
        ? {
            title: content.title || video.story.title,
            ageGroup: video.story.ageGroup,
            language: video.story.language,
            premise: content.premise,
            learningOutcome: content.learningOutcome,
          }
        : null,
    durationSeconds: computeTimeline(video.clips, video.editSettings).total,
    scenes: video.clips.map((c, i) => {
      const scene = c.sceneId ? sceneText.get(c.sceneId) : undefined;
      return { number: i + 1, title: c.title, action: scene?.action ?? "", narration: scene?.narration ?? "" };
    }),
  });

  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { ...prompt, model: config.model, effort: config.effort, maxTokens: 8_000, subject: "video metadata" },
    videoMetadataSuggestionSchema,
  );

  try {
    await db.insert(shortGenerations).values({
      planId: video.planId,
      kind: "video_metadata",
      ok: result.ok,
      model: result.model,
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      cacheReadTokens: result.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
      durationMs: result.durationMs,
      error: result.ok ? null : result.message,
    });
    if (!result.ok) return { ok: false, message: result.message };
    const m = result.data;
    await db
      .update(videos)
      .set({
        title: m.title.trim().slice(0, TITLE_MAX) || video.title,
        description: m.description.trim(),
        hashtags: normalizeHashtags(m.hashtags),
        playlist: m.playlist.trim(),
        metadataApprovedAt: null,
        ...afterEdit(video.status),
      })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return m.childSafety.status === "concern"
      ? { ok: false, message: `Suggestions filled in, but Claude flagged a concern: ${m.childSafety.notes}` }
      : { ok: true, message: "Suggestions filled in. Review and approve the metadata." };
  } catch (error) {
    console.error("suggestVideoMetadata save failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

// ---------- Review ----------

async function reviewBlockers(video: Video) {
  const ffmpegAvailable = Boolean(await getFfmpegVersion());
  const checks = evaluateVideoQuality(buildVideoQualityInput(video, ffmpegAvailable));
  return videoApprovalBlockers(checks, { rendered: Boolean(video.renderFilePath), metadataApproved: Boolean(video.metadataApprovedAt) });
}

export async function submitVideoForReview(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("submitVideoForReview", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (video.status !== "draft") return { ok: false, message: "Only draft videos can be submitted for review" };
    const blockers = await reviewBlockers(video);
    if (blockers.length) return { ok: false, message: blockers[0] };
    await db.update(videos).set({ status: "ready_for_review", reviewNotes: null }).where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: "Ready for review. Watch the whole render, then approve or reject it." };
  });
}

/** Ready for review -> approved. `confirmed` is the reviewer's explicit sign-off from the UI. */
export async function approveVideo(id: string, confirmed: boolean): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  if (confirmed !== true) return { ok: false, message: "Confirm that you watched the video before approving it" };
  return guarded("approveVideo", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (video.status !== "ready_for_review") return { ok: false, message: "Submit the video for review before approving it" };
    const blockers = await reviewBlockers(video);
    if (blockers.length) return { ok: false, message: blockers[0] };
    const result = await db
      .update(videos)
      .set({ status: "approved", reviewedAt: new Date(), reviewNotes: null })
      .where(and(eq(videos.id, video.id), eq(videos.status, "ready_for_review")))
      .returning({ id: videos.id });
    if (!result.length) return { ok: false, message: "The video changed while you were reviewing it. Reload and review it again." };
    revalidateVideos(video.id);
    return { ok: true, message: "Video approved and added to the publishing queue" };
  });
}

export async function rejectVideo(id: string, notes: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  const reason = z.string().trim().max(2000).safeParse(notes);
  if (!videoId.success || !reason.success) return { ok: false, message: "Invalid input" };
  return guarded("rejectVideo", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    await db
      .update(videos)
      .set({ status: "rejected", scheduledAt: null, publishError: null, reviewedAt: new Date(), reviewNotes: reason.data || null })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: "Video rejected. It won't be published; reopen it any time." };
  });
}

export async function reopenVideo(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("reopenVideo", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (isVideoLocked(video)) return { ok: false, message: LOCKED };
    await db.update(videos).set({ status: "draft", scheduledAt: null, publishError: null }).where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: "Back to draft" };
  });
}

// ---------- Publishing ----------

const NOT_APPROVED = "Only approved videos can be scheduled or published. Approve it in the Video Studio first.";
const ALREADY_UPLOADED = "This video is already on YouTube. Change it in YouTube Studio.";

export async function scheduleVideo(id: string, when: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  const date = z.coerce.date().safeParse(when);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  if (!date.success || Number.isNaN(date.data.getTime())) return { ok: false, message: "Choose a date and time" };
  if (date.data.getTime() < Date.now()) return { ok: false, message: "Choose a time in the future" };
  return guarded("scheduleVideo", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (!isPublishable(video.status)) return { ok: false, message: NOT_APPROVED };
    if (video.youtubeVideoId) return { ok: false, message: ALREADY_UPLOADED };
    await db
      .update(videos)
      .set({ status: "scheduled", scheduledAt: date.data, publishError: null, publishFailedAt: null })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: "Time saved. Nothing is uploaded until you choose “Upload to YouTube” for this video." };
  });
}

export async function unscheduleVideo(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("unscheduleVideo", async () => {
    const result = await db
      .update(videos)
      .set({ status: "approved", scheduledAt: null, publishError: null, publishFailedAt: null })
      .where(and(eq(videos.id, videoId.data), inArray(videos.status, ["scheduled", "failed"]), isNull(videos.youtubeVideoId)))
      .returning({ id: videos.id });
    if (!result.length) return { ok: false, message: "The video isn't scheduled, or is already on YouTube" };
    revalidateVideos(videoId.data);
    return { ok: true, message: "Schedule removed" };
  });
}

const publishSchema = z.object({
  id: idSchema,
  mode: z.enum(["now", "schedule"]),
  // The literal `true` from the confirmation dialog: an upload never happens without it.
  confirmed: z.literal(true),
});

/** An upload that started this long ago without finishing is treated as abandoned. */
const UPLOAD_LOCK_MS = 2 * 60 * 60_000;
/** YouTube needs a little lead time for a scheduled publish. */
const MIN_SCHEDULE_LEAD_MS = 5 * 60_000;

/** Uploads an approved video to the connected channel. Runs only when the user confirms it. */
export async function publishVideoToYouTube(id: string, mode: "now" | "schedule", confirmed: boolean): Promise<ActionResult> {
  const input = publishSchema.safeParse({ id, mode, confirmed });
  if (!input.success) return { ok: false, message: "Confirm the upload in the dialog first" };
  if (!getYouTubeConfig().configured) return { ok: false, message: "YouTube isn't configured. See Settings." };

  let claimed = false;
  try {
    const context = await getVideoPublishContext(input.data.id);
    if (!context) return { ok: false, message: "Video not found" };
    const { video } = context;
    if (!isPublishable(video.status) || !video.reviewedAt) return { ok: false, message: NOT_APPROVED };
    if (video.youtubeVideoId) return { ok: false, message: ALREADY_UPLOADED };
    if (!video.metadataApprovedAt) return { ok: false, message: "Approve the metadata first" };
    if (!video.renderFilePath || !isVideoRenderCurrent(video)) return { ok: false, message: "The render is missing or out of date. Render it again." };
    const file = resolveMediaPath(video.renderFilePath);
    if (!file) return { ok: false, message: "The rendered file isn't in the media folder" };
    if (input.data.mode === "schedule" && (!video.scheduledAt || video.scheduledAt.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS)) {
      return { ok: false, message: "Set a publish time at least 5 minutes from now first, or publish now" };
    }
    if (!(await getYouTubeConnection())) return { ok: false, message: "Connect a YouTube channel in Settings first" };

    // Claim the video so a double click or a second tab can't upload it twice.
    const claim = await db
      .update(videos)
      .set({ uploadStartedAt: new Date() })
      .where(
        and(
          eq(videos.id, video.id),
          eq(videos.status, video.status),
          isNull(videos.youtubeVideoId),
          or(isNull(videos.uploadStartedAt), lt(videos.uploadStartedAt, new Date(Date.now() - UPLOAD_LOCK_MS))),
        ),
      )
      .returning({ id: videos.id });
    if (!claim.length) return { ok: false, message: "An upload of this video is already running, or it changed. Reload the page." };
    claimed = true;

    const metadata = buildYouTubeMetadata({
      title: video.title,
      description: uploadDescription(video),
      hashtags: video.hashtags,
      playlist: video.playlist,
      language: context.storyLanguage,
      madeForKids: context.madeForKids ?? true,
      containsSyntheticMedia: context.containsSyntheticMedia ?? true,
      scheduledAt: input.data.mode === "schedule" ? video.scheduledAt : null,
      hasCaptions: video.clips.some((c) => c.captions.length > 0),
      visibility: input.data.mode === "now" ? "public" : "private",
    });

    let uploaded;
    try {
      const client = await getYouTubeClient();
      const bytes = await readFile(file);
      uploaded = await client.uploadVideo({ metadata: { snippet: metadata.snippet, status: metadata.status }, bytes, contentType: "video/mp4" });
    } catch (error) {
      const known = error instanceof YouTubeError;
      let message = known ? error.message : "The upload failed unexpectedly";
      // A lost response after the bytes arrived may still have created the video.
      if (!known || error.status === null || error.status >= 500) message += " Check YouTube Studio before retrying, in case it went through.";
      console.error("publishVideoToYouTube upload failed", error);
      await db
        .update(videos)
        .set({ status: "failed", publishError: message, publishFailedAt: new Date(), uploadStartedAt: null })
        .where(eq(videos.id, video.id));
      claimed = false;
      revalidateVideos(video.id);
      return { ok: false, message };
    }

    const now = input.data.mode === "now";
    try {
      await db
        .update(videos)
        .set({
          status: now ? "published" : "scheduled",
          youtubeVideoId: uploaded.id,
          youtubeUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
          publishedAt: now ? new Date() : null,
          ...(now ? { scheduledAt: null } : {}),
          uploadStartedAt: null,
          publishError: null,
          publishFailedAt: null,
        })
        .where(eq(videos.id, video.id));
    } catch (error) {
      console.error(`publishVideoToYouTube: uploaded video ${uploaded.id} but couldn't record it`, error);
      return { ok: false, message: `Uploaded to YouTube (video ${uploaded.id}), but saving that here failed. Don't upload it again: mark it published with that link.` };
    }
    claimed = false;
    revalidateVideos(video.id);

    // Projects that haven't passed Google's API audit get their uploads locked to private.
    if (now && uploaded.status?.privacyStatus && uploaded.status.privacyStatus !== "public") {
      return { ok: true, message: `Uploaded, but YouTube set it to ${uploaded.status.privacyStatus}. Unaudited API projects can only upload private videos: make it public in YouTube Studio.` };
    }
    return {
      ok: true,
      message: now ? "Published on YouTube. It may take a few minutes to process." : "Uploaded as private. YouTube will publish it at the scheduled time.",
    };
  } catch (error) {
    console.error("publishVideoToYouTube failed", error);
    return { ok: false, message: DB_ERROR };
  } finally {
    if (claimed) await db.update(videos).set({ uploadStartedAt: null }).where(eq(videos.id, input.data.id)).catch(() => undefined);
  }
}

/** Reads the uploaded video's status from YouTube and records a scheduled video going live. */
export async function refreshVideoYouTubeStatus(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  try {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (!video.youtubeVideoId) return { ok: false, message: "This video wasn't uploaded by this app" };
    const [remote] = await (await getYouTubeClient()).getVideos([video.youtubeVideoId]);
    if (!remote) return { ok: false, message: "YouTube can't find this video. If you deleted it, use “Forget upload”." };
    const status = remote.status ?? {};
    if (status.uploadStatus === "failed" || status.uploadStatus === "rejected") {
      const message = `YouTube ${status.uploadStatus} the video${status.failureReason || status.rejectionReason ? ` (${status.failureReason ?? status.rejectionReason})` : ""}.`;
      await db.update(videos).set({ status: "failed", publishError: message, publishFailedAt: new Date() }).where(eq(videos.id, video.id));
      revalidateVideos(video.id);
      return { ok: false, message };
    }
    if (status.privacyStatus === "public" && video.status !== "published") {
      await db
        .update(videos)
        .set({ status: "published", publishedAt: video.scheduledAt && video.scheduledAt < new Date() ? video.scheduledAt : new Date() })
        .where(eq(videos.id, video.id));
      revalidateVideos(video.id);
      return { ok: true, message: "It's live: marked as published" };
    }
    return { ok: true, message: `On YouTube: ${status.privacyStatus ?? "unknown visibility"}, ${status.uploadStatus ?? "processing"}` };
  } catch (error) {
    if (error instanceof YouTubeError) return { ok: false, message: error.message };
    console.error("refreshVideoYouTubeStatus failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

const youtubeUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((s) => s === "" || /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(s), "Enter a youtube.com or youtu.be link");

/** For videos uploaded by hand in YouTube Studio. */
export async function markVideoPublished(id: string, url: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  const link = youtubeUrlSchema.safeParse(url);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  if (!link.success) return { ok: false, message: link.error.issues[0].message };
  return guarded("markVideoPublished", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    if (!isPublishable(video.status)) return { ok: false, message: "Only approved or scheduled videos can be marked published" };
    if (video.youtubeVideoId) return { ok: false, message: "This video was uploaded by the app. Use “Check YouTube” instead." };
    await db
      .update(videos)
      .set({
        status: "published",
        publishedAt: video.scheduledAt && video.scheduledAt < new Date() ? video.scheduledAt : new Date(),
        youtubeUrl: link.data || null,
        publishError: null,
        publishFailedAt: null,
      })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return { ok: true, message: "Marked as published" };
  });
}

/** Undoes "published" (or forgets an app upload). A video on YouTube stays there until removed in YouTube Studio. */
export async function unmarkVideoPublished(id: string): Promise<ActionResult> {
  const videoId = idSchema.safeParse(id);
  if (!videoId.success) return { ok: false, message: "Invalid video id" };
  return guarded("unmarkVideoPublished", async () => {
    const video = await loadVideo(videoId.data);
    if (!video) return { ok: false, message: "Video not found" };
    const uploaded = video.youtubeVideoId !== null;
    if (video.status !== "published" && !uploaded) return { ok: false, message: "The video isn't published or uploaded" };
    await db
      .update(videos)
      .set({ status: "approved", publishedAt: null, ...(uploaded ? { youtubeVideoId: null, youtubeUrl: null, scheduledAt: null } : {}) })
      .where(eq(videos.id, video.id));
    revalidateVideos(video.id);
    return {
      ok: true,
      message: uploaded ? "Upload forgotten. The video stays on YouTube until you delete it in YouTube Studio." : "Back to approved",
    };
  });
}
