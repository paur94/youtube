"use server";

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { assets, productionPlans, productionScenes, type Short, shortGenerations, shortMetrics, shorts } from "@/db/schema";
import { approvalBlockers, evaluateQuality } from "@/lib/short-qc";
import { buildAssFile, computeFraming } from "@/lib/short-video";
import {
  applyPublishOrder,
  buildCaptionsFromDialogue,
  DEFAULT_VIDEO_SETTINGS,
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
import { buildQualityInput, getShort } from "@/server/queries/shorts";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.
// Nothing here uploads to YouTube: publishing is tracked, not performed.

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

const LOCKED = "Published Shorts are locked. Mark it as not published first to edit it.";

/** Editing an approved or scheduled Short sends it back to draft so it is approved again. */
function afterEdit(status: ShortStatus) {
  return status === "approved" || status === "scheduled" ? { status: "draft" as const, scheduledAt: null } : {};
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
  if (short.status === "published") return { ok: false, message: LOCKED };

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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
    if (short.status === "published") return { ok: false, message: LOCKED };
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
  if (short.status === "published") return { ok: false, message: LOCKED };
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

export async function approveShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("approveShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "draft") return { ok: false, message: "Only draft Shorts can be approved" };
    const ffmpegAvailable = Boolean(await getFfmpegVersion());
    const checks = evaluateQuality(buildQualityInput(short, { ffmpegAvailable, hasDialogue: short.captions.length > 0 }));
    const blockers = approvalBlockers(checks, { rendered: Boolean(short.renderFilePath), metadataApproved: Boolean(short.metadataApprovedAt) });
    if (blockers.length) return { ok: false, message: blockers[0] };
    await db.update(shorts).set({ status: "approved", reviewedAt: new Date(), reviewNotes: null }).where(eq(shorts.id, short.id));
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
    if (short.status === "published") return { ok: false, message: LOCKED };
    await db
      .update(shorts)
      .set({ status: "rejected", scheduledAt: null, reviewedAt: new Date(), reviewNotes: reason.data || null })
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
    if (short.status === "published") return { ok: false, message: LOCKED };
    await db.update(shorts).set({ status: "draft", scheduledAt: null }).where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Back to draft" };
  });
}

// ---------- Publishing (tracking only: nothing is uploaded) ----------

export async function scheduleShort(id: string, when: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const date = z.coerce.date().safeParse(when);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!date.success || Number.isNaN(date.data.getTime())) return { ok: false, message: "Choose a date and time" };
  if (date.data.getTime() < Date.now()) return { ok: false, message: "Choose a time in the future" };
  return guarded("scheduleShort", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "approved" && short.status !== "scheduled") return { ok: false, message: "Approve the Short before scheduling it" };
    await db.update(shorts).set({ status: "scheduled", scheduledAt: date.data }).where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Scheduled. Set the same time in YouTube Studio when you upload: nothing is published automatically." };
  });
}

export async function unscheduleShort(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("unscheduleShort", async () => {
    const result = await db
      .update(shorts)
      .set({ status: "approved", scheduledAt: null })
      .where(and(eq(shorts.id, shortId.data), eq(shorts.status, "scheduled")))
      .returning({ id: shorts.id });
    if (!result.length) return { ok: false, message: "The Short isn't scheduled" };
    revalidateShorts(shortId.data);
    return { ok: true, message: "Schedule removed" };
  });
}

const youtubeUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((s) => s === "" || /^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(s), "Enter a youtube.com or youtu.be link");

export async function markPublished(id: string, url: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  const link = youtubeUrlSchema.safeParse(url);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  if (!link.success) return { ok: false, message: link.error.issues[0].message };
  return guarded("markPublished", async () => {
    const short = await loadShort(shortId.data);
    if (!short) return { ok: false, message: "Short not found" };
    if (short.status !== "approved" && short.status !== "scheduled") return { ok: false, message: "Only approved or scheduled Shorts can be marked published" };
    await db
      .update(shorts)
      .set({ status: "published", publishedAt: short.scheduledAt && short.scheduledAt < new Date() ? short.scheduledAt : new Date(), youtubeUrl: link.data || null })
      .where(eq(shorts.id, short.id));
    revalidateShorts(short.id);
    return { ok: true, message: "Marked as published. Add its numbers on the Analytics page." };
  });
}

export async function unmarkPublished(id: string): Promise<ActionResult> {
  const shortId = idSchema.safeParse(id);
  if (!shortId.success) return { ok: false, message: "Invalid Short id" };
  return guarded("unmarkPublished", async () => {
    const result = await db
      .update(shorts)
      .set({ status: "approved", publishedAt: null })
      .where(and(eq(shorts.id, shortId.data), eq(shorts.status, "published")))
      .returning({ id: shorts.id });
    if (!result.length) return { ok: false, message: "The Short isn't marked published" };
    revalidateShorts(shortId.data);
    return { ok: true, message: "Back to approved" };
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
