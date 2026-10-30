"use server";

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { assets, productionPlans, productionScenes, type Short, shortGenerations, shortMetrics, shorts } from "@/db/schema";
import { approvalBlockers, evaluateQuality } from "@/lib/short-qc";
import { buildAssFile, computeFraming } from "@/lib/short-video";
import {
  applyPublishOrder,
  buildCaptionsFromDialogue,
  buildYouTubeMetadata,
  DEFAULT_VIDEO_SETTINGS,
  isPublishable,
  isShortLocked,
  normalizeHashtags,
  parseCaptionLines,
  parseMetricsForm,
  parseShortMetadataForm,
  publishOrderSchema,
  renderKey,
  shortAnalysisSchema,
  type ShortMetadataState,
  type ShortStatus,
  videoSettingsSchema,
} from "@/lib/shorts";
import type { StoryContent } from "@/lib/stories";
import {
  getClaudeClient,
  getClaudeConfig,
  NOT_CONFIGURED_MESSAGE,
  runStructuredGeneration,
  type StructuredResult,
} from "@/server/ai/claude";
import { buildPublishOrderPrompt, buildShortAnalysisPrompt } from "@/server/ai/shorts-prompt";
import { FfmpegError, getFfmpegVersion, measureLoudness, probeMedia, renderVertical } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";
import { getYouTubeConfig, YouTubeError } from "@/server/providers/youtube";
import { buildQualityInput, getShort, getShortPublishContext, isRenderCurrent } from "@/server/queries/shorts";
import { getYouTubeClient, getYouTubeConnection } from "@/server/youtube/connection";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.
// Nothing is ever uploaded or published automatically: publishShortToYouTube runs only when the user
// clicks it and confirms, and only for a Short they explicitly approved after review.

const idSchema = z.uuid();

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function revalidateShorts(id?: string) {
  revalidatePath("/shorts");
  revalidatePath("/publishing");
  revalidatePath("/analytics");
  if (id) revalidatePath(`/shorts/${id}`);
}

async function loadShort(id: string) {
  const [row] = await db.select().from(shorts).where(eq(shorts.id, id));
  return row ?? null;
}

const LOCKED = "Published or uploaded Shorts are locked. Mark it as not published on the Publishing page first to edit it.";

/** Editing a Short that is in or past review sends it back to draft, so it is reviewed and approved again. */
function afterEdit(status: ShortStatus) {
  return status === "draft" || status === "rejected" ? {} : { status: "draft" as const, scheduledAt: null, publishError: null };
}

function guarded(name: string, fn: () => Promise<ActionResult>) {
  return fn().catch((error: unknown) => {
    console.error(`${name} failed`, error);
    return { ok: false as const, message: error instanceof FfmpegError ? error.message : DB_ERROR };
  });
}

// ---------- Import ----------

function storySceneFor(content: StoryContent | null, sceneNumber: number, title: string) {
  if (!content) return null;
  return (
    content.scenes.find((s) => s.title.trim().toLowerCase() === title.trim().toLowerCase()) ??
    content.scenes.find((s) => Number(s.number) === sceneNumber) ??
    null
  );
}

/** Creates one draft Short per selected scene. Scenes that already have a Short are skipped. */
export async function importShorts(sceneIds: string[]): Promise<ActionResult> {
  const ids = z.array(idSchema).min(1, "Select at least one scene").max(100).safeParse(sceneIds);
  if (!ids.success) return { ok: false, message: ids.error.issues[0].message };

  return guarded("importShorts", async () => {
    const rows = await db
      .select({ scene: productionScenes, plan: productionPlans, asset: assets })
      .from(productionScenes)
      .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
      .innerJoin(assets, eq(productionScenes.selectedAssetId, assets.id))
      .where(and(inArray(productionScenes.id, ids.data), eq(assets.kind, "video"), eq(assets.status, "approved")))
      .orderBy(asc(productionScenes.position));
    const usable = rows.filter((r) => r.asset.filePath);
    if (!usable.length) return { ok: false, message: "None of the selected scenes has an approved final video on disk" };

    const ffmpeg = await getFfmpegVersion();
    let created = 0;
    for (const { scene, plan, asset } of usable) {
      const probe = ffmpeg ? await probeMedia(asset.filePath!).catch(() => null) : null;
      const duration = probe?.durationSeconds ?? (asset.durationSeconds ? Number(asset.durationSeconds) : scene.durationSeconds);
      const inserted = await db
        .insert(shorts)
        .values({
          sceneId: scene.id,
          planId: plan.id,
          storyId: plan.storyId,
          sourceAssetId: asset.id,
          sceneTitle: scene.title,
          sceneNumber: scene.position + 1,
          sourceFilePath: asset.filePath,
          sourceProbe: probe,
          title: scene.title,
          publishOrder: scene.position + 1,
          captions: buildCaptionsFromDialogue(scene.dialogue, duration),
          videoSettings: DEFAULT_VIDEO_SETTINGS,
        })
        .onConflictDoNothing()
        .returning({ id: shorts.id });
      created += inserted.length;
    }
    revalidateShorts();
    const skipped = ids.data.length - created;
    return {
      ok: true,
      message: `Created ${created} Short${created === 1 ? "" : "s"}${skipped ? ` · ${skipped} skipped (already imported or no approved video)` : ""}`,
    };
  });
}

/** Points the Short at the scene's current final clip (after it was replaced in production). */
export async function switchToCurrentSceneClip(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("switchToCurrentSceneClip", async () => {
    const short = await loadShort(shortId.data);
    if (!short?.sceneId) return { ok: false, message: "The scene no longer exists" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    const [row] = await db
      .select({ asset: assets })
      .from(productionScenes)
      .innerJoin(assets, eq(productionScenes.selectedAssetId, assets.id))
      .where(eq(productionScenes.id, short.sceneId));
    if (!row?.asset.filePath || row.asset.kind !== "video" || row.asset.status !== "approved") {
      return { ok: false, message: "The scene has no approved final video" };
    }
    const probe = (await getFfmpegVersion()) ? await probeMedia(row.asset.filePath).catch(() => null) : null;
    await db
      .update(shorts)
      .set({ sourceAssetId: row.asset.id, sourceFilePath: row.asset.filePath, sourceProbe: probe, captionsReviewed: false, ...afterEdit(short.status) })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Now using the scene's current final clip. Check the captions and render again." };
  });
}

export async function deleteShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("deleteShort", async () => {
    await db.delete(shorts).where(eq(shorts.id, shortId.data));
    revalidateShorts();
    return { ok: true, message: "Short deleted. The scene, its clip and rendered files stay on disk." };
  });
}

// ---------- Claude ----------

async function logGeneration(
  values: { shortId?: string; planId?: string | null; kind: string },
  result: StructuredResult<unknown>,
) {
  await db.insert(shortGenerations).values({
    shortId: values.shortId,
    planId: values.planId ?? null,
    kind: values.kind,
    ok: result.ok,
    model: result.model,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    cacheReadTokens: result.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
    durationMs: result.durationMs,
    error: result.ok ? null : result.message,
  });
}

/**
 * Asks Claude whether the scene works as a standalone Short and for a hook, narration, music and
 * sound suggestions and metadata. Metadata is filled in only when the Short has none of its own yet.
 */
export async function analyzeShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  let short: Awaited<ReturnType<typeof getShort>>;
  try {
    short = await getShort(shortId.data);
  } catch (error) {
    console.error("analyzeShort failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!short) return { ok: false, message: "Short not found" };
  if (isShortLocked(short)) return { ok: false, message: LOCKED };

  const content = short.story?.content ?? null;
  const storyScene = storySceneFor(content, short.sceneNumber, short.sceneTitle);
  const summary = (s: { title: string; action: string } | null) => (s ? `"${s.title}": ${s.action.slice(0, 300)}` : null);
  const prompt = buildShortAnalysisPrompt({
    story:
      short.story && content
        ? {
            title: content.title || short.story.title,
            ageGroup: short.story.ageGroup,
            language: short.story.language,
            premise: content.premise,
            learningOutcome: content.learningOutcome,
          }
        : null,
    scene: {
      number: short.sceneNumber,
      total: short.sceneCount || short.sceneNumber,
      title: short.scene?.title ?? short.sceneTitle,
      setting: short.scene?.setting ?? storyScene?.setting ?? "",
      action: short.scene?.action ?? storyScene?.action ?? "",
      narration: short.scene?.narration ?? storyScene?.narration ?? "",
      dialogue: short.scene?.dialogue ?? storyScene?.dialogue ?? [],
      durationSeconds: short.sourceProbe?.durationSeconds ?? null,
      soundEffects: storyScene?.soundEffects ?? [],
      musicMood: storyScene?.musicMood ?? "",
    },
    previousScene: summary(short.previousScene),
    nextScene: summary(short.nextScene),
  });

  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { ...prompt, model: config.model, effort: config.effort, maxTokens: 16_000, subject: "Short analysis" },
    shortAnalysisSchema,
  );

  try {
    await logGeneration({ shortId: short.id, planId: short.planId, kind: "analysis" }, result);
    if (!result.ok) {
      revalidateShorts(short.id);
      return { ok: false, message: result.message };
    }
    const a = result.data;
    const untouched = !short.metadataApprovedAt && !short.description && !short.hashtags.length && short.title === short.sceneTitle;
    await db
      .update(shorts)
      .set({
        analysis: a,
        analyzedAt: new Date(),
        ...(untouched
          ? {
              title: a.metadata.title.trim().slice(0, 100) || short.title,
              description: a.metadata.description.trim(),
              hashtags: normalizeHashtags(a.metadata.hashtags),
              playlist: a.metadata.playlist.trim(),
              hook: short.hook || a.hook.onScreenText.trim().slice(0, 120),
            }
          : {}),
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return {
      ok: true,
      message: untouched
        ? "Analysis done. Suggested metadata filled in: review and approve it."
        : "Analysis done. Your metadata was kept; use “Apply suggestions” to replace it.",
    };
  } catch (error) {
    console.error("analyzeShort save failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export async function applySuggestedMetadata(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("applySuggestedMetadata", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    if (!short.analysis) return { ok: false, message: "Run the analysis first" };
    const m = short.analysis.metadata;
    await db
      .update(shorts)
      .set({
        title: m.title.trim().slice(0, 100) || short.title,
        description: m.description.trim(),
        hashtags: normalizeHashtags(m.hashtags),
        playlist: m.playlist.trim(),
        hook: short.analysis.hook.onScreenText.trim().slice(0, 120),
        metadataApprovedAt: null,
        ...afterEdit(short.status),
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Suggestions applied. Review and approve the metadata." };
  });
}

/** Asks Claude for a release order across one plan's Shorts and stores it as editable positions. */
export async function suggestPublishOrder(planId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(planId);
  if (!id.success) return { ok: false, message: "Invalid plan id" };
  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  let rows: Short[];
  let storyTitle: string | null = null;
  try {
    rows = await db.select().from(shorts).where(eq(shorts.planId, id.data)).orderBy(asc(shorts.sceneNumber));
    const [plan] = await db.select({ title: productionPlans.title }).from(productionPlans).where(eq(productionPlans.id, id.data));
    storyTitle = plan?.title ?? null;
  } catch (error) {
    console.error("suggestPublishOrder failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (rows.length < 2) return { ok: false, message: "Import at least two Shorts from this plan first" };

  const prompt = buildPublishOrderPrompt(
    storyTitle,
    rows.map((s, i) => ({ number: i + 1, sceneNumber: s.sceneNumber, title: s.title, analysis: s.analysis })),
  );
  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { ...prompt, model: config.model, effort: config.effort, maxTokens: 8000, subject: "publishing order" },
    publishOrderSchema,
  );

  try {
    await logGeneration({ planId: id.data, kind: "publish_order" }, result);
    if (!result.ok) return { ok: false, message: result.message };
    const ordered = applyPublishOrder(
      rows.map((r) => r.id),
      result.data,
    );
    await db.transaction(async (tx) => {
      for (const o of ordered) {
        await tx.update(shorts).set({ publishOrder: o.position, publishOrderReason: o.reason }).where(eq(shorts.id, o.id));
      }
    });
  } catch (error) {
    console.error("suggestPublishOrder save failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateShorts();
  return { ok: true, message: result.data.note ? `Order suggested. ${result.data.note}` : "Publishing order suggested. Edit any position on the Short." };
}

// ---------- Editing ----------

export async function updateShortMetadata(id: string, _prev: ShortMetadataState, formData: FormData): Promise<ShortMetadataState> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  const parsed = parseShortMetadataForm(formData);
  if (!parsed.success) return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  try {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    const d = parsed.data;
    const metadataChanged =
      d.title !== short.title ||
      d.description !== short.description ||
      d.hashtags.join(" ") !== short.hashtags.join(" ") ||
      d.playlist !== short.playlist ||
      d.hook !== short.hook ||
      d.hookSeconds !== short.hookSeconds;
    await db
      .update(shorts)
      .set({
        ...d,
        publishOrderReason: d.publishOrder === short.publishOrder ? short.publishOrderReason : "Set by hand.",
        ...(metadataChanged ? { metadataApprovedAt: null, ...afterEdit(short.status) } : {}),
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return {
      ok: true,
      message: metadataChanged
        ? short.metadataApprovedAt
          ? "Saved. The metadata changed, so approve it again."
          : "Saved. Approve the metadata when it's final."
        : "Saved",
    };
  } catch (error) {
    console.error("updateShortMetadata failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export async function setMetadataApproval(id: string, approved: boolean): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("setMetadataApproval", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    if (approved && !short.title.trim()) return { ok: false, message: "Add a title first" };
    await db
      .update(shorts)
      .set({ metadataApprovedAt: approved ? new Date() : null, ...(approved ? {} : afterEdit(short.status)) })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: approved ? "Metadata approved" : "Metadata approval removed" };
  });
}

export async function updateVideoSettings(id: string, settings: unknown): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const parsed = videoSettingsSchema.safeParse(settings);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!parsed.success) return { ok: false, message: "Invalid video settings" };
  return guarded("updateVideoSettings", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    const changed = JSON.stringify(parsed.data) !== JSON.stringify(short.videoSettings);
    await db
      .update(shorts)
      .set({ videoSettings: parsed.data, ...(changed ? afterEdit(short.status) : {}) })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: changed ? "Video settings saved. Render again to apply them." : "No changes" };
  });
}

export async function updateCaptions(id: string, text: string, reviewed: boolean): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (text.length > 20_000) return { ok: false, message: "Captions are too long" };
  const { cues, errors } = parseCaptionLines(text);
  if (errors.length) return { ok: false, message: errors[0] };
  return guarded("updateCaptions", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    const changed = JSON.stringify(cues) !== JSON.stringify(short.captions);
    await db
      .update(shorts)
      .set({ captions: cues, captionsReviewed: reviewed, ...(changed ? afterEdit(short.status) : {}) })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: `${cues.length} caption${cues.length === 1 ? "" : "s"} saved` };
  });
}

/** Rebuilds estimated captions from the scene's current dialogue. */
export async function rebuildCaptions(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("rebuildCaptions", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    if (!short.sceneId) return { ok: false, message: "The scene no longer exists" };
    const [scene] = await db
      .select({ dialogue: productionScenes.dialogue, durationSeconds: productionScenes.durationSeconds })
      .from(productionScenes)
      .where(eq(productionScenes.id, short.sceneId));
    if (!scene) return { ok: false, message: "The scene no longer exists" };
    const captions = buildCaptionsFromDialogue(scene.dialogue, short.sourceProbe?.durationSeconds ?? scene.durationSeconds);
    await db
      .update(shorts)
      .set({ captions, captionsReviewed: false, ...afterEdit(short.status) })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: `${captions.length} captions rebuilt from the dialogue. Check their timing.` };
  });
}

// ---------- FFmpeg ----------

/** Renders the 9:16 version into a new file; the source clip is only read. */
export async function renderShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!(await getFfmpegVersion())) {
    return { ok: false, message: "FFmpeg isn't installed. Install it or set FFMPEG_PATH and FFPROBE_PATH in .env.local, then restart." };
  }

  let short: Short | null;
  try {
    short = await loadShort(shortId.data);
  } catch (error) {
    console.error("renderShort failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (!short) return { ok: false, message: "Short not found" };
  if (isShortLocked(short)) return { ok: false, message: LOCKED };
  if (!short.sourceFilePath) return { ok: false, message: "The source clip isn't stored locally" };

  try {
    const source = short.sourceProbe?.width ? short.sourceProbe : await probeMedia(short.sourceFilePath);
    if (!source.width || !source.height) throw new FfmpegError("The source has no video stream");
    const framing = computeFraming(source.width, source.height, short.videoSettings);
    const s = short.videoSettings;
    const cues = s.burnCaptions ? short.captions : [];
    const hook = s.showHook && short.hook.trim() ? short.hook : null;
    const ass = cues.length || hook ? buildAssFile({ cues, hook, hookSeconds: short.hookSeconds, framing }) : null;

    const filePath = await renderVertical({
      sourcePath: short.sourceFilePath,
      folder: `shorts/${short.id}`,
      fileName: `${randomUUID()}.mp4`,
      framing,
      assSubtitles: ass,
      normalizeAudio: s.normalizeAudio,
    });
    const outputProbe = await probeMedia(filePath);
    const outputAudio = outputProbe.hasAudio ? await measureLoudness(filePath).catch(() => null) : null;

    await db
      .update(shorts)
      .set({
        sourceProbe: source,
        renderFilePath: filePath,
        renderKey: renderKey({ ...short, settings: short.videoSettings }),
        renderedAt: new Date(),
        renderError: null,
        outputProbe,
        outputAudio,
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Vertical version rendered. Watch it before approving." };
  } catch (error) {
    const message = error instanceof FfmpegError ? error.message : "Rendering failed unexpectedly";
    console.error("renderShort failed", error);
    await db.update(shorts).set({ renderError: message }).where(eq(shorts.id, short.id)).catch(() => undefined);
    revalidateShorts(short.id);
    return { ok: false, message };
  }
}

export async function probeShortSource(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("probeShortSource", async () => {
    if (!(await getFfmpegVersion())) return { ok: false, message: "FFmpeg isn't installed" };
    const short = await loadShort(shortId.data);
    if (!short?.sourceFilePath) return { ok: false, message: "The source clip isn't stored locally" };
    const probe = await probeMedia(short.sourceFilePath);
    await db.update(shorts).set({ sourceProbe: probe }).where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Source clip measured" };
  });
}

// ---------- Review ----------

async function reviewBlockers(short: Short) {
  const ffmpegAvailable = Boolean(await getFfmpegVersion());
  const checks = evaluateQuality(buildQualityInput(short, { ffmpegAvailable, hasDialogue: short.captions.length > 0 }));
  return approvalBlockers(checks, { rendered: Boolean(short.renderFilePath), metadataApproved: Boolean(short.metadataApprovedAt) });
}

/** Draft -> ready for review, once the automatic checks pass. Approval is a separate, explicit step. */
export async function submitShortForReview(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("submitShortForReview", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "draft") return { ok: false, message: "Only draft Shorts can be submitted for review" };
    const blockers = await reviewBlockers(short);
    if (blockers.length) return { ok: false, message: blockers[0] };
    await db.update(shorts).set({ status: "ready_for_review", reviewNotes: null }).where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Ready for review. Watch the rendered version, then approve or reject it." };
  });
}

/** Ready for review -> approved. `confirmed` is the reviewer's explicit sign-off from the UI. */
export async function approveShort(id: string, confirmed: boolean): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (confirmed !== true) return { ok: false, message: "Confirm that you watched the Short before approving it" };
  return guarded("approveShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "ready_for_review") return { ok: false, message: "Submit the Short for review before approving it" };
    const blockers = await reviewBlockers(short);
    if (blockers.length) return { ok: false, message: blockers[0] };
    const result = await db
      .update(shorts)
      .set({ status: "approved", reviewedAt: new Date(), reviewNotes: null })
      .where(and(eq(shorts.id, short.id), eq(shorts.status, "ready_for_review")))
      .returning({ id: shorts.id });
    if (!result.length) return { ok: false, message: "The Short changed while you were reviewing it. Reload and review it again." };
    revalidateShorts(short.id);
    return { ok: true, message: "Short approved and added to the publishing queue" };
  });
}

export async function rejectShort(id: string, notes: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const reason = z.string().trim().max(2000).safeParse(notes);
  if (!shortId.success || !reason.success) return { ok: false, message: "Invalid input" };
  return guarded("rejectShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    await db
      .update(shorts)
      .set({ status: "rejected", scheduledAt: null, publishError: null, reviewedAt: new Date(), reviewNotes: reason.data || null })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Short rejected. It won't be published; reopen it any time." };
  });
}

export async function reopenShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("reopenShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (isShortLocked(short)) return { ok: false, message: LOCKED };
    await db.update(shorts).set({ status: "draft", scheduledAt: null, publishError: null }).where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Back to draft" };
  });
}

// ---------- Publishing ----------
// Every step here is a user action. Scheduling only records a time in this app; the video goes to
// YouTube only from publishShortToYouTube, which the user starts and confirms per Short.

const NOT_APPROVED = "Only approved Shorts can be scheduled or published. Approve it in the Shorts Studio first.";
const ALREADY_UPLOADED = "This Short is already on YouTube. Change it in YouTube Studio.";

export async function scheduleShort(id: string, when: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const date = z.coerce.date().safeParse(when);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!date.success || Number.isNaN(date.data.getTime())) return { ok: false, message: "Choose a date and time" };
  if (date.data.getTime() < Date.now()) return { ok: false, message: "Choose a time in the future" };
  return guarded("scheduleShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (!isPublishable(short.status)) return { ok: false, message: NOT_APPROVED };
    if (short.youtubeVideoId) return { ok: false, message: ALREADY_UPLOADED };
    await db
      .update(shorts)
      .set({ status: "scheduled", scheduledAt: date.data, publishError: null, publishFailedAt: null })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Time saved. Nothing is uploaded until you choose “Upload to YouTube” for this Short." };
  });
}

export async function unscheduleShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("unscheduleShort", async () => {
    const result = await db
      .update(shorts)
      .set({ status: "approved", scheduledAt: null, publishError: null, publishFailedAt: null })
      .where(and(eq(shorts.id, shortId.data), inArray(shorts.status, ["scheduled", "failed"]), isNull(shorts.youtubeVideoId)))
      .returning({ id: shorts.id });
    if (!result.length) return { ok: false, message: "The Short isn't scheduled, or is already on YouTube" };
    revalidateShorts(shortId.data);
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
const UPLOAD_LOCK_MS = 30 * 60_000;
/** YouTube needs a little lead time for a scheduled publish. */
const MIN_SCHEDULE_LEAD_MS = 5 * 60_000;

/**
 * Uploads an approved Short to the connected channel, either public now or private with YouTube's
 * own scheduled publish time. Runs only when the user confirms it in the publishing queue.
 */
export async function publishShortToYouTube(id: string, mode: "now" | "schedule", confirmed: boolean): Promise<ActionResult> {
  const input = publishSchema.safeParse({ id, mode, confirmed });
  if (!input.success) return { ok: false, message: "Confirm the upload in the dialog first" };
  if (!getYouTubeConfig().configured) return { ok: false, message: "YouTube isn't configured. See Settings." };

  let claimed = false;
  try {
    const context = await getShortPublishContext(input.data.id);
    if (!context) return { ok: false, message: "Short not found" };
    const { short } = context;
    if (!isPublishable(short.status) || !short.reviewedAt) return { ok: false, message: NOT_APPROVED };
    if (short.youtubeVideoId) return { ok: false, message: ALREADY_UPLOADED };
    if (!short.metadataApprovedAt) return { ok: false, message: "Approve the metadata first" };
    if (!short.renderFilePath || !isRenderCurrent(short)) return { ok: false, message: "The vertical render is missing or out of date. Re-render it." };
    const file = resolveMediaPath(short.renderFilePath);
    if (!file) return { ok: false, message: "The rendered file isn't in the media folder" };
    if (input.data.mode === "schedule" && (!short.scheduledAt || short.scheduledAt.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS)) {
      return { ok: false, message: "Set a publish time at least 5 minutes from now first, or publish now" };
    }
    if (!(await getYouTubeConnection())) return { ok: false, message: "Connect a YouTube channel in Settings first" };

    // Claim the Short so a double click or a second tab can't upload it twice.
    const claim = await db
      .update(shorts)
      .set({ uploadStartedAt: new Date() })
      .where(
        and(
          eq(shorts.id, short.id),
          eq(shorts.status, short.status),
          isNull(shorts.youtubeVideoId),
          or(isNull(shorts.uploadStartedAt), lt(shorts.uploadStartedAt, new Date(Date.now() - UPLOAD_LOCK_MS))),
        ),
      )
      .returning({ id: shorts.id });
    if (!claim.length) return { ok: false, message: "An upload of this Short is already running, or it changed. Reload the page." };
    claimed = true;

    const metadata = buildYouTubeMetadata({
      title: short.title,
      description: short.description,
      hashtags: short.hashtags,
      playlist: short.playlist,
      language: context.storyLanguage,
      madeForKids: context.madeForKids ?? true,
      containsSyntheticMedia: context.containsSyntheticMedia ?? true,
      scheduledAt: input.data.mode === "schedule" ? short.scheduledAt : null,
      hasCaptions: short.captions.length > 0,
      visibility: input.data.mode === "now" ? "public" : "private",
    });

    let video;
    try {
      const client = await getYouTubeClient();
      const bytes = await readFile(file);
      video = await client.uploadVideo({ metadata: { snippet: metadata.snippet, status: metadata.status }, bytes, contentType: "video/mp4" });
    } catch (error) {
      const known = error instanceof YouTubeError;
      let message = known ? error.message : "The upload failed unexpectedly";
      // A lost response after the bytes arrived may still have created the video.
      if (!known || error.status === null || error.status >= 500) message += " Check YouTube Studio before retrying, in case it went through.";
      console.error("publishShortToYouTube upload failed", error);
      await db
        .update(shorts)
        .set({ status: "failed", publishError: message, publishFailedAt: new Date(), uploadStartedAt: null })
        .where(eq(shorts.id, short.id));
      claimed = false;
      revalidateShorts(short.id);
      return { ok: false, message };
    }

    const now = input.data.mode === "now";
    try {
      await db
        .update(shorts)
        .set({
          status: now ? "published" : "scheduled",
          youtubeVideoId: video.id,
          youtubeUrl: `https://youtube.com/shorts/${video.id}`,
          publishedAt: now ? new Date() : null,
          ...(now ? { scheduledAt: null } : {}),
          uploadStartedAt: null,
          publishError: null,
          publishFailedAt: null,
        })
        .where(eq(shorts.id, short.id));
    } catch (error) {
      console.error(`publishShortToYouTube: uploaded video ${video.id} but couldn't record it`, error);
      return { ok: false, message: `Uploaded to YouTube (video ${video.id}), but saving that here failed. Don't upload it again: mark it published with that link.` };
    }
    claimed = false;
    revalidateShorts(short.id);

    // Projects that haven't passed Google's API audit get their uploads locked to private.
    if (now && video.status?.privacyStatus && video.status.privacyStatus !== "public") {
      return { ok: true, message: `Uploaded, but YouTube set it to ${video.status.privacyStatus}. Unaudited API projects can only upload private videos: make it public in YouTube Studio.` };
    }
    return {
      ok: true,
      message: now
        ? "Published on YouTube. It may take a few minutes to process."
        : "Uploaded as private. YouTube will publish it at the scheduled time.",
    };
  } catch (error) {
    console.error("publishShortToYouTube failed", error);
    return { ok: false, message: DB_ERROR };
  } finally {
    if (claimed) await db.update(shorts).set({ uploadStartedAt: null }).where(eq(shorts.id, input.data.id)).catch(() => undefined);
  }
}

/** Reads the uploaded video's status from YouTube and records a scheduled Short going live. */
export async function refreshYouTubeStatus(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  try {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (!short.youtubeVideoId) return { ok: false, message: "This Short wasn't uploaded by this app" };
    const [video] = await (await getYouTubeClient()).getVideos([short.youtubeVideoId]);
    if (!video) return { ok: false, message: "YouTube can't find this video. If you deleted it, use “Forget upload”." };
    const status = video.status ?? {};
    if (status.uploadStatus === "failed" || status.uploadStatus === "rejected") {
      const message = `YouTube ${status.uploadStatus} the video${status.failureReason || status.rejectionReason ? ` (${status.failureReason ?? status.rejectionReason})` : ""}.`;
      await db.update(shorts).set({ status: "failed", publishError: message, publishFailedAt: new Date() }).where(eq(shorts.id, short.id));
      revalidateShorts(short.id);
      return { ok: false, message };
    }
    if (status.privacyStatus === "public" && short.status !== "published") {
      await db
        .update(shorts)
        .set({ status: "published", publishedAt: short.scheduledAt && short.scheduledAt < new Date() ? short.scheduledAt : new Date() })
        .where(eq(shorts.id, short.id));
      revalidateShorts(short.id);
      return { ok: true, message: "It's live: marked as published" };
    }
    return { ok: true, message: `On YouTube: ${status.privacyStatus ?? "unknown visibility"}, ${status.uploadStatus ?? "processing"}` };
  } catch (error) {
    if (error instanceof YouTubeError) return { ok: false, message: error.message };
    console.error("refreshYouTubeStatus failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

const youtubeUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((s) => s === "" || /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(s), "Enter a youtube.com or youtu.be link");

/** For Shorts uploaded by hand in YouTube Studio. */
export async function markPublished(id: string, url: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const link = youtubeUrlSchema.safeParse(url);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!link.success) return { ok: false, message: link.error.issues[0].message };
  return guarded("markPublished", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (!isPublishable(short.status)) return { ok: false, message: "Only approved or scheduled Shorts can be marked published" };
    if (short.youtubeVideoId) return { ok: false, message: "This Short was uploaded by the app. Use “Check YouTube” instead." };
    await db
      .update(shorts)
      .set({
        status: "published",
        publishedAt: short.scheduledAt && short.scheduledAt < new Date() ? short.scheduledAt : new Date(),
        youtubeUrl: link.data || null,
        publishError: null,
        publishFailedAt: null,
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Marked as published. Add its numbers on the Analytics page." };
  });
}

/**
 * Undoes "published" (or forgets an app upload that is still scheduled). Only this app's record
 * changes: a video on YouTube stays there until it is removed in YouTube Studio.
 */
export async function unmarkPublished(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("unmarkPublished", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    const uploaded = short.youtubeVideoId !== null;
    if (short.status !== "published" && !uploaded) return { ok: false, message: "The Short isn't published or uploaded" };
    await db
      .update(shorts)
      .set({
        status: "approved",
        publishedAt: null,
        ...(uploaded ? { youtubeVideoId: null, youtubeUrl: null, scheduledAt: null } : {}),
      })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return {
      ok: true,
      message: uploaded ? "Upload forgotten. The video stays on YouTube until you delete it in YouTube Studio." : "Back to approved",
    };
  });
}

// ---------- Analytics ----------

export type MetricsFormState = { ok: true; message: string } | { ok: false; message: string } | null;

export async function addShortMetrics(id: string, _prev: MetricsFormState, formData: FormData): Promise<MetricsFormState> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  const parsed = parseMetricsForm(formData);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: `${String(issue.path[0] ?? "Value")}: ${issue.message}` };
  }
  try {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "published") return { ok: false, message: "Metrics only exist once the Short is published" };
    await db.insert(shortMetrics).values({ shortId: short.id, ...parsed.data });
  } catch (error) {
    console.error("addShortMetrics failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateShorts(shortId.data);
  return { ok: true, message: "Snapshot saved" };
}

export async function deleteShortMetrics(id: string): Promise<ActionResult> {
  const metricId = idSchema.safeParse(id);
  if (!metricId.success) return { ok: false, message: "Invalid id" };
  return guarded("deleteShortMetrics", async () => {
    await db.delete(shortMetrics).where(eq(shortMetrics.id, metricId.data));
    revalidateShorts();
    return { ok: true, message: "Snapshot deleted" };
  });
}
