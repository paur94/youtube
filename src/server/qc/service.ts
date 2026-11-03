import "server-only";

import { readFile } from "node:fs/promises";

import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";

import { db } from "@/db";
import { assets, characters, productionPlans, productionScenes, sceneCharacters, shortGenerations, storyCharacters } from "@/db/schema";
import {
  buildCorrectedPrompt,
  checkPlanRules,
  consistencyCheck,
  criticalIssues,
  type PlanContinuity,
  pickFrameTimes,
  preflightResultSchema,
  type QcIssue,
  type QcScene,
  readSceneContinuity,
  readVisionReport,
  type SceneContinuity,
  sceneQcState,
  stripCorrections,
  toQcIssues,
  visionResultSchema,
  type VisionReport,
  visionStatus,
} from "@/lib/story-qc";
import { buildPreflightPrompt, buildVisionText, VISION_SYSTEM_PROMPT } from "@/server/ai/qc-prompt";
import { getClaudeClient, getClaudeConfig, NOT_CONFIGURED_MESSAGE, runStructuredGeneration, type StructuredResult } from "@/server/ai/claude";
import { downscaleImage, extractFrames, FfmpegError, getFfmpegVersion, probeMedia } from "@/server/media/ffmpeg";
import { resolveMediaPath } from "@/server/media/storage";

import { pickCharacterReferences } from "../production/service";

export type QcResult = { ok: true; message: string } | { ok: false; message: string };

/** Reference images per vision call: enough to pin down the cast without paying for a gallery. */
const MAX_VISION_REFERENCES = 4;
const MAX_FRAMES = 8;

// ---------- Loading ----------

type SceneRow = typeof productionScenes.$inferSelect;

export type SceneQc = {
  scene: SceneRow;
  qc: QcScene;
  continuity: SceneContinuity;
  rules: QcIssue[];
  state: ReturnType<typeof sceneQcState>;
};

/** Every scene of a plan with its rule checks (which need the earlier scenes) and stored QC state. */
export async function loadPlanQc(planId: string) {
  const [plan] = await db.select().from(productionPlans).where(eq(productionPlans.id, planId));
  if (!plan) return null;
  const scenes = await db
    .select()
    .from(productionScenes)
    .where(eq(productionScenes.planId, planId))
    .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt));
  const sceneIds = scenes.map((s) => s.id);
  const links = sceneIds.length
    ? await db
        .select({
          sceneId: sceneCharacters.sceneId,
          id: characters.id,
          name: characters.name,
          visualDescription: characters.visualDescription,
          primaryReferenceId: characters.primaryReferenceId,
        })
        .from(sceneCharacters)
        .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
        .where(inArray(sceneCharacters.sceneId, sceneIds))
        .orderBy(asc(characters.name))
    : [];
  const characterIds = [...new Set(links.map((l) => l.id))];
  const withReference = new Set(
    characterIds.length
      ? (
          await db
            .select({ characterId: assets.characterId })
            .from(assets)
            .where(and(inArray(assets.characterId, characterIds), eq(assets.kind, "image"), eq(assets.status, "approved")))
        ).map((r) => r.characterId)
      : [],
  );

  const qcScenes: QcScene[] = scenes.map((scene, i) => ({
    id: scene.id,
    number: i + 1,
    title: scene.title,
    setting: scene.setting,
    action: scene.action,
    narration: scene.narration,
    dialogue: scene.dialogue,
    visualPrompt: scene.visualPrompt,
    durationSeconds: scene.durationSeconds,
    characters: links
      .filter((l) => l.sceneId === scene.id)
      .map((l) => ({ name: l.name, visualDescription: l.visualDescription, hasReference: withReference.has(l.id) })),
  }));
  const rules = checkPlanRules(qcScenes);
  const rows: SceneQc[] = scenes.map((scene, i) => {
    const continuity = readSceneContinuity(scene.continuity);
    const sceneRules = rules.get(scene.id) ?? [];
    return { scene, qc: qcScenes[i], continuity, rules: sceneRules, state: sceneQcState(qcScenes[i], sceneRules, continuity) };
  });
  return { plan, scenes: rows, links };
}

export async function loadSceneQc(sceneId: string) {
  const [row] = await db.select({ planId: productionScenes.planId }).from(productionScenes).where(eq(productionScenes.id, sceneId));
  if (!row) return null;
  const plan = await loadPlanQc(row.planId);
  const scene = plan?.scenes.find((s) => s.scene.id === sceneId);
  return plan && scene ? { ...plan, current: scene } : null;
}

/** Issues that still count: not dismissed and not already written into the prompt as a correction. */
function settled(continuity: SceneContinuity) {
  return [...continuity.dismissed, ...(continuity.corrected ?? [])];
}

/** Critical, unresolved preflight issues. Generating with any of these would waste money. */
export function generationBlockers(scene: SceneQc) {
  return criticalIssues(scene.state.issues, settled(scene.continuity));
}

export async function sceneGenerationBlockers(sceneId: string) {
  const loaded = await loadSceneQc(sceneId);
  return loaded ? generationBlockers(loaded.current) : [];
}

// ---------- Logging ----------

async function logUsage(planId: string, kind: string, result: StructuredResult<unknown>) {
  await db.insert(shortGenerations).values({
    planId,
    kind,
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

// ---------- Stage 1: Claude preflight ----------

/**
 * One text-only Claude call for the whole plan: shot lists, continuity bible and logical issues.
 * Skipped when every scene was already checked with its current script, unless forced.
 */
export async function runPreflight(planId: string, force = false): Promise<QcResult> {
  const loaded = await loadPlanQc(planId);
  if (!loaded) return { ok: false, message: "Plan not found" };
  if (!loaded.scenes.length) return { ok: false, message: "The plan has no scenes" };
  if (!force && loaded.plan.continuity && loaded.scenes.every((s) => s.state.preflightCurrent)) {
    return { ok: true, message: "Every scene was already checked with its current script. Nothing was sent to Claude." };
  }
  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  const referenceLabels = await labelSceneReferences(loaded.scenes.flatMap((s) => s.continuity.referenceAssetIds));
  const cast = new Map<string, { name: string; visualDescription: string; references: number }>();
  for (const s of loaded.scenes) {
    for (const c of s.qc.characters) cast.set(c.name, { name: c.name, visualDescription: c.visualDescription, references: c.hasReference ? 1 : 0 });
  }
  const prompt = buildPreflightPrompt({
    title: loaded.plan.title,
    visualStyle: loaded.plan.visualStyle,
    characters: [...cast.values()],
    scenes: loaded.scenes.map((s) => ({
      ...s.qc,
      visualPrompt: stripCorrections(s.qc.visualPrompt),
      referenceLabels: s.continuity.referenceAssetIds.map((id) => referenceLabels.get(id) ?? "image"),
    })),
  });
  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { ...prompt, model: config.model, effort: config.effort, maxTokens: 32_000, subject: "story QC" },
    preflightResultSchema,
  );
  await logUsage(planId, "qc_preflight", result);
  if (!result.ok) return { ok: false, message: result.message };

  const now = new Date().toISOString();
  let flagged = 0;
  await db.transaction(async (tx) => {
    for (const s of loaded.scenes) {
      const out = result.data.scenes.find((r) => Number(r.sceneNumber) === s.qc.number);
      if (!out) continue;
      const issues = toQcIssues("ai", out.issues);
      if (issues.some((i) => i.severity === "critical")) flagged++;
      const continuity: SceneContinuity = {
        ...s.continuity,
        preflight: { specHash: s.state.specHash, checkedAt: now, model: result.model, shots: out.shots, issues, promptAdditions: out.promptAdditions.trim() },
        // Corrections for issues that no longer exist are forgotten.
        corrected: (s.continuity.corrected ?? []).filter((id) => issues.some((i) => i.id === id)),
      };
      await tx.update(productionScenes).set({ continuity }).where(eq(productionScenes.id, s.scene.id));
    }
    const plan: PlanContinuity = { bible: result.data.bible, checkedAt: now, model: result.model };
    await tx.update(productionPlans).set({ continuity: plan }).where(eq(productionPlans.id, planId));
  });
  return {
    ok: true,
    message: flagged
      ? `Story checked. ${flagged} scene${flagged === 1 ? " has" : "s have"} critical issues to fix before generating.`
      : "Story checked. No critical contradictions found.",
  };
}

async function labelSceneReferences(ids: string[]) {
  const labels = new Map<string, string>();
  if (!ids.length) return labels;
  const rows = await db
    .select({ id: assets.id, revision: assets.revision, characterName: characters.name, sceneTitle: productionScenes.title })
    .from(assets)
    .leftJoin(characters, eq(assets.characterId, characters.id))
    .leftJoin(productionScenes, eq(assets.sceneId, productionScenes.id))
    .where(inArray(assets.id, [...new Set(ids)]));
  for (const r of rows) labels.set(r.id, r.characterName ? `${r.characterName} reference` : `keyframe from "${r.sceneTitle ?? "a scene"}" r${r.revision}`);
  return labels;
}

// ---------- Stage 2: vision check ----------

function imageBlock(jpeg: Buffer): Anthropic.Beta.BetaImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } };
}

/** A reference as a small JPEG; without FFmpeg, the original when the API accepts it as is. */
async function referenceImage(asset: typeof assets.$inferSelect, ffmpeg: boolean): Promise<Anthropic.Beta.BetaImageBlockParam | null> {
  if (!asset.filePath) return null;
  if (ffmpeg) return imageBlock(await downscaleImage(asset.filePath));
  const file = resolveMediaPath(asset.filePath);
  const type = asset.contentType as "image/jpeg" | "image/png" | "image/webp" | "image/gif" | null;
  if (!file || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type) || (asset.sizeBytes ?? 0) > 4_000_000) return null;
  return { type: "image", source: { type: "base64", media_type: type, data: (await readFile(file)).toString("base64") } };
}

/**
 * Compares a generated clip (or keyframe) with the story: frames at every shot, the character and
 * scene references, the script and the continuity bible. The report is saved on the asset and reused
 * until the script changes, so each clip is paid for once.
 */
export async function runVisionCheck(assetId: string, force = false): Promise<QcResult & { status?: string }> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset?.sceneId) return { ok: false, message: "Only scene assets can be inspected" };
  if (!asset.filePath || !resolveMediaPath(asset.filePath)) return { ok: false, message: "The file isn't stored locally, so it can't be inspected" };
  const loaded = await loadSceneQc(asset.sceneId);
  if (!loaded) return { ok: false, message: "Scene not found" };
  const { current, plan, links } = loaded;

  const existing = readVisionReport(asset.metadata);
  if (!force && existing && existing.specHash === current.state.specHash) {
    return { ok: true, message: "Already inspected against the current script. Nothing was sent to Claude." };
  }
  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  const ffmpeg = Boolean(await getFfmpegVersion());
  const isImage = asset.kind === "image";
  if (!isImage && !ffmpeg) return { ok: false, message: "FFmpeg is needed to extract frames from the clip. Install it or set FFMPEG_PATH." };

  const shots = current.state.preflightCurrent ? (current.continuity.preflight?.shots ?? []) : [];
  let frames: { time: number; jpeg: Buffer }[] = [];
  let still: Anthropic.Beta.BetaImageBlockParam | null = null;
  try {
    if (isImage) {
      still = await referenceImage(asset, ffmpeg);
      if (!still) return { ok: false, message: "This image format can't be inspected without FFmpeg" };
    } else {
      const probe = await probeMedia(asset.filePath);
      const duration = probe.durationSeconds ?? (asset.durationSeconds ? Number(asset.durationSeconds) : current.scene.durationSeconds);
      frames = await extractFrames(asset.filePath, pickFrameTimes(duration, shots, MAX_FRAMES));
    }
  } catch (error) {
    return { ok: false, message: error instanceof FfmpegError ? error.message : "Could not read frames from the file" };
  }

  // Character references (primary first) and the scene's own extra references, capped to keep the call cheap.
  const linked = links.filter((l) => l.sceneId === current.scene.id);
  const characterRefs = await pickCharacterReferences(linked);
  const sceneRefs = current.continuity.referenceAssetIds.length
    ? await db.select().from(assets).where(and(inArray(assets.id, current.continuity.referenceAssetIds), ne(assets.status, "rejected")))
    : [];
  const refs = [
    ...characterRefs.map((r) => ({ label: `${r.names.join(" and ")} (character reference)`, asset: r.asset })),
    ...sceneRefs.map((a) => ({ label: `scene reference r${a.revision}`, asset: a })),
  ].slice(0, MAX_VISION_REFERENCES);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const referenceLabels: string[] = [];
  for (const ref of refs) {
    const block = await referenceImage(ref.asset, ffmpeg).catch(() => null);
    if (!block) continue;
    referenceLabels.push(ref.label);
    content.push({ type: "text", text: `Reference: ${ref.label}` }, block);
  }
  if (still) {
    content.push({ type: "text", text: "Keyframe to inspect:" }, still);
  } else {
    for (const f of frames) content.push({ type: "text", text: `Frame at ${f.time}s:` }, imageBlock(f.jpeg));
  }
  const text = buildVisionText({
    scene: current.qc,
    shots,
    bible: plan.continuity?.bible ?? null,
    frameTimes: frames.map((f) => f.time),
    referenceLabels,
    isImage,
  });
  content.push({ type: "text", text });

  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { system: VISION_SYSTEM_PROMPT, user: text, content, model: config.model, effort: config.effort, maxTokens: 16_000, subject: "vision check" },
    visionResultSchema,
  );
  await logUsage(plan.id, "qc_vision", result);
  if (!result.ok) return { ok: false, message: result.message };

  const report: VisionReport = {
    specHash: current.state.specHash,
    checkedAt: new Date().toISOString(),
    model: result.model,
    frames: result.data.frames,
    issues: toQcIssues("vision", result.data.issues),
    thumbnail: result.data.thumbnail,
    summary: result.data.summary.trim(),
    promptAdditions: result.data.promptAdditions.trim(),
  };
  // Re-read inside the update so a concurrent metadata change (e.g. a download error note) isn't lost.
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ metadata: assets.metadata }).from(assets).where(eq(assets.id, asset.id)).for("update");
    await tx.update(assets).set({ metadata: { ...(row?.metadata ?? {}), qc: report } }).where(eq(assets.id, asset.id));
  });
  const status = visionStatus(report, current.state.specHash, current.continuity.dismissed);
  const critical = report.issues.filter((i) => i.severity === "critical").length;
  return {
    ok: true,
    status,
    message:
      status === "fail"
        ? `Inspected: ${critical} critical mismatch${critical === 1 ? "" : "es"} with the story. Fix the prompt and regenerate.`
        : status === "warn"
          ? "Inspected: minor mismatches only. Review them."
          : "Inspected: the picture matches the story.",
  };
}

// ---------- Corrections and regeneration ----------

/** The newest inspected video of the scene that failed: its findings feed the corrected prompt. */
function latestFailedReport(sceneAssets: (typeof assets.$inferSelect)[], scene: SceneQc) {
  for (const a of sceneAssets) {
    const report = readVisionReport(a.metadata);
    if (report && visionStatus(report, scene.state.specHash, scene.continuity.dismissed) === "fail") return report;
  }
  return null;
}

/**
 * Appends explicit visual requirements for every open issue (script rules, Claude preflight and the
 * last failed vision check) to the scene's visual prompt. The previous prompt is kept in the history.
 */
export async function applyPromptCorrections(sceneId: string): Promise<QcResult> {
  const loaded = await loadSceneQc(sceneId);
  if (!loaded) return { ok: false, message: "Scene not found" };
  const s = loaded.current;
  const sceneAssets = await db.select().from(assets).where(eq(assets.sceneId, sceneId)).orderBy(desc(assets.revision));
  const failed = latestFailedReport(sceneAssets, s);
  const dismissed = new Set(s.continuity.dismissed);
  const open = [...s.state.issues, ...(failed?.issues ?? [])].filter((i) => !dismissed.has(i.id));
  const additions = [s.state.preflightCurrent ? (s.continuity.preflight?.promptAdditions ?? "") : "", failed?.promptAdditions ?? ""];
  const corrected = buildCorrectedPrompt(s.scene.visualPrompt, open, additions);
  if (!corrected || corrected === s.scene.visualPrompt) return { ok: true, message: "No corrections needed: the prompt already covers every open issue." };

  const continuity: SceneContinuity = {
    ...s.continuity,
    corrected: [...new Set([...(s.continuity.corrected ?? []), ...open.filter((i) => i.source !== "rules").map((i) => i.id)])],
    promptHistory: [{ prompt: s.scene.visualPrompt, replacedAt: new Date().toISOString(), reason: "Automatic continuity correction" }, ...s.continuity.promptHistory].slice(0, 10),
  };
  await db.update(productionScenes).set({ visualPrompt: corrected, continuity }).where(eq(productionScenes.id, sceneId));
  return { ok: true, message: "Continuity requirements added to the visual prompt. The previous prompt is kept in the history." };
}

export async function restorePreviousPrompt(sceneId: string): Promise<QcResult> {
  const [scene] = await db.select().from(productionScenes).where(eq(productionScenes.id, sceneId));
  if (!scene) return { ok: false, message: "Scene not found" };
  const continuity = readSceneContinuity(scene.continuity);
  const [previous, ...rest] = continuity.promptHistory;
  if (!previous) return { ok: false, message: "There is no earlier prompt" };
  await db
    .update(productionScenes)
    .set({ visualPrompt: previous.prompt, continuity: { ...continuity, promptHistory: rest, corrected: [] } })
    .where(eq(productionScenes.id, sceneId));
  return { ok: true, message: "Previous visual prompt restored" };
}

export async function updateSceneContinuity(sceneId: string, change: (c: SceneContinuity) => SceneContinuity) {
  const [scene] = await db.select({ continuity: productionScenes.continuity }).from(productionScenes).where(eq(productionScenes.id, sceneId));
  if (!scene) return false;
  await db.update(productionScenes).set({ continuity: change(readSceneContinuity(scene.continuity)) }).where(eq(productionScenes.id, sceneId));
  return true;
}

/** Scenes whose current final clip, or newest inspected clip, failed the vision check. */
export async function scenesNeedingRegeneration(planId: string) {
  const loaded = await loadPlanQc(planId);
  if (!loaded) return [];
  const ids = loaded.scenes.map((s) => s.scene.id);
  const sceneAssets = ids.length
    ? await db.select().from(assets).where(and(inArray(assets.sceneId, ids), eq(assets.kind, "video"))).orderBy(desc(assets.revision))
    : [];
  return loaded.scenes.filter((s) => {
    const own = sceneAssets.filter((a) => a.sceneId === s.scene.id);
    const final = own.find((a) => a.id === s.scene.selectedAssetId);
    const inspected = final && readVisionReport(final.metadata) ? final : own.find((a) => readVisionReport(a.metadata));
    return inspected ? visionStatus(readVisionReport(inspected.metadata), s.state.specHash, s.continuity.dismissed) === "fail" : false;
  });
}

// ---------- Stage 3: publishing ----------

export type ConsistencyItem = { sceneId: string | null; assetId: string | null; label: string };

/**
 * The story-consistency check for a Short (one clip) or a full video (many). Combines the preflight
 * criticals of each scene with the vision report of the exact clip being published.
 */
export async function evaluateConsistency(items: ConsistencyItem[], plans = new Map<string, ReturnType<typeof loadPlanQc>>()) {
  const usable = items.filter((i): i is ConsistencyItem & { sceneId: string } => Boolean(i.sceneId));
  if (!usable.length) return null;
  const [planRow] = await db.select({ planId: productionScenes.planId }).from(productionScenes).where(eq(productionScenes.id, usable[0].sceneId));
  if (planRow && !plans.has(planRow.planId)) plans.set(planRow.planId, loadPlanQc(planRow.planId));
  const plan = planRow ? await plans.get(planRow.planId)! : null;
  const assetIds = usable.map((i) => i.assetId).filter((id): id is string => Boolean(id));
  const reports = new Map(
    (assetIds.length ? await db.select({ id: assets.id, metadata: assets.metadata }).from(assets).where(inArray(assets.id, assetIds)) : []).map((a) => [
      a.id,
      readVisionReport(a.metadata),
    ]),
  );

  const results = usable.map((item) => {
    const s = plan?.scenes.find((x) => x.scene.id === item.sceneId);
    const report = item.assetId ? (reports.get(item.assetId) ?? null) : null;
    const dismissed = s ? settled(s.continuity) : [];
    return consistencyCheck({
      sceneLabel: item.label,
      preflightCritical: s ? generationBlockers(s) : [],
      vision: report,
      visionStatus: visionStatus(report, s?.state.specHash ?? null, s?.continuity.dismissed ?? []),
      dismissed,
    });
  });
  const status = results.some((r) => r.status === "fail") ? "fail" : results.some((r) => r.status === "warn") ? "warn" : "pass";
  const details = results.flatMap((r) => (status === "pass" ? r.details : r.details.filter((d) => !d.includes("matches the story"))));
  return { status, details: details.slice(0, 8) } as const;
}

/**
 * Why an approved asset can't become the scene's final yet, or null. A replacement must pass the
 * vision check before it takes over, so the current final stays in place until then. Without Claude
 * configured, only known failures block, so the studio keeps working.
 */
export async function selectionBlocker(sceneId: string, assetId: string) {
  const loaded = await loadSceneQc(sceneId);
  if (!loaded) return null;
  const s = loaded.current;
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return null;
  const report = readVisionReport(asset.metadata);
  const status = visionStatus(report, s.state.specHash, s.continuity.dismissed);
  if (status === "fail") {
    const first = criticalIssues(report!.issues, s.continuity.dismissed)[0];
    return `This version doesn't match the story${first ? `: ${first.message}` : ""}. Fix the prompt and regenerate, or dismiss the issue after checking it yourself.`;
  }
  const replacing = s.scene.selectedAssetId && s.scene.selectedAssetId !== assetId;
  if (replacing && asset.kind === "video" && (status === "unchecked" || status === "stale") && getClaudeConfig().configured) {
    return "Inspect this replacement with the vision check first. The current final clip stays in place until a replacement passes.";
  }
  return null;
}

/**
 * Re-generates only the scenes whose clip failed the vision check: corrects each prompt, then submits
 * one new generation per scene with the plan's video model. Originals stay selected until a
 * replacement passes review.
 */
export async function regenerateFailedScenes(
  planId: string,
  submit: (sceneId: string, modelId: string, startAssetId: string | null) => Promise<QcResult>,
  requiresStartImage: boolean,
): Promise<QcResult> {
  const failed = await scenesNeedingRegeneration(planId);
  if (!failed.length) return { ok: true, message: "No scene has a clip that failed the vision check." };
  const [plan] = await db.select({ videoModel: productionPlans.videoModel }).from(productionPlans).where(eq(productionPlans.id, planId));
  if (!plan) return { ok: false, message: "Plan not found" };

  const outcomes: string[] = [];
  let submitted = 0;
  for (const s of failed) {
    const label = `Scene ${s.qc.number}`;
    await applyPromptCorrections(s.scene.id);
    const blockers = await sceneGenerationBlockers(s.scene.id);
    if (blockers.length) {
      outcomes.push(`${label}: ${blockers[0].message}`);
      continue;
    }
    let start: string | null = null;
    if (requiresStartImage) {
      const [keyframe] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.sceneId, s.scene.id), eq(assets.kind, "image"), eq(assets.status, "approved")))
        .orderBy(desc(assets.revision))
        .limit(1);
      if (!keyframe) {
        outcomes.push(`${label}: the video model needs an approved keyframe image`);
        continue;
      }
      start = keyframe.id;
    }
    const result = await submit(s.scene.id, plan.videoModel, start);
    if (result.ok) submitted++;
    else outcomes.push(`${label}: ${result.message}`);
  }
  const message = `Corrected and resubmitted ${submitted} of ${failed.length} scene${failed.length === 1 ? "" : "s"}.${outcomes.length ? ` ${outcomes.join(" · ")}` : ""}`;
  return { ok: submitted > 0, message };
}

type ShortRef = { id: string; sceneId: string | null; sourceAssetId: string | null; sceneNumber: number };

export function shortConsistency(short: Omit<ShortRef, "id">, plans?: Map<string, ReturnType<typeof loadPlanQc>>) {
  return evaluateConsistency([{ sceneId: short.sceneId, assetId: short.sourceAssetId, label: `Scene ${short.sceneNumber}` }], plans);
}

/** Consistency of many Shorts (list pages), loading each plan once. */
export async function shortsConsistency(shorts: ShortRef[]) {
  const plans = new Map<string, ReturnType<typeof loadPlanQc>>();
  const results = new Map<string, Awaited<ReturnType<typeof evaluateConsistency>>>();
  for (const short of shorts) results.set(short.id, await shortConsistency(short, plans));
  return results;
}

export function videoConsistency(video: { clips: { sceneId: string | null; assetId: string; sceneNumber: number }[] }) {
  return evaluateConsistency(video.clips.map((c) => ({ sceneId: c.sceneId, assetId: c.assetId, label: `Scene ${c.sceneNumber}` })));
}

/** Refuses an upload while the published clip(s) have unresolved critical story mismatches. */
export function consistencyPublishBlocker(result: Awaited<ReturnType<typeof evaluateConsistency>>) {
  return result?.status === "fail" ? `Story consistency: ${result.details[0] ?? "unresolved critical issues"}` : null;
}

/**
 * Images that can be attached as scene references: every image generated for the story (any scene,
 * approved or still awaiting review) and the approved references of the story's characters.
 * This scene's own images come first.
 */
export async function getReferenceCandidates(input: { planId: string; sceneId: string; storyId: string | null; characterIds: string[] }) {
  const storyCast = input.storyId
    ? (await db.select({ id: storyCharacters.characterId }).from(storyCharacters).where(eq(storyCharacters.storyId, input.storyId))).map((r) => r.id)
    : [];
  const castIds = [...new Set([...input.characterIds, ...storyCast])];
  const [sceneImages, characterImages] = await Promise.all([
    db
      .select({
        id: assets.id,
        status: assets.status,
        revision: assets.revision,
        filePath: assets.filePath,
        sourceUrl: assets.sourceUrl,
        sceneId: productionScenes.id,
        sceneTitle: productionScenes.title,
        position: productionScenes.position,
      })
      .from(assets)
      .innerJoin(productionScenes, eq(assets.sceneId, productionScenes.id))
      .where(and(eq(productionScenes.planId, input.planId), eq(assets.kind, "image"), ne(assets.status, "rejected")))
      .orderBy(asc(productionScenes.position), desc(assets.revision)),
    castIds.length
      ? db
          .select({ id: assets.id, status: assets.status, revision: assets.revision, filePath: assets.filePath, sourceUrl: assets.sourceUrl, name: characters.name })
          .from(assets)
          .innerJoin(characters, eq(assets.characterId, characters.id))
          .where(and(inArray(assets.characterId, castIds), eq(assets.kind, "image"), eq(assets.status, "approved")))
          .orderBy(asc(characters.name), desc(assets.revision))
      : Promise.resolve([]),
  ]);
  const own = sceneImages.filter((a) => a.sceneId === input.sceneId);
  const others = sceneImages.filter((a) => a.sceneId !== input.sceneId);
  return [
    ...own.map((a) => ({ id: a.id, status: a.status, filePath: a.filePath, sourceUrl: a.sourceUrl, group: "This scene", label: `r${a.revision}` })),
    ...others.map((a) => ({
      id: a.id,
      status: a.status,
      filePath: a.filePath,
      sourceUrl: a.sourceUrl,
      group: "Other scenes in this story",
      label: `Scene ${a.position + 1} “${a.sceneTitle}” r${a.revision}`,
    })),
    ...characterImages.map((a) => ({ id: a.id, status: a.status, filePath: a.filePath, sourceUrl: a.sourceUrl, group: "Characters", label: `${a.name} r${a.revision}` })),
  ];
}

/** Per-scene QC overview for the plan page. */
export async function getPlanQcOverview(planId: string) {
  const loaded = await loadPlanQc(planId);
  if (!loaded) return null;
  const finalIds = loaded.scenes.map((s) => s.scene.selectedAssetId).filter((id): id is string => Boolean(id));
  const finals = new Map(
    (finalIds.length ? await db.select({ id: assets.id, metadata: assets.metadata }).from(assets).where(inArray(assets.id, finalIds)) : []).map((a) => [
      a.id,
      readVisionReport(a.metadata),
    ]),
  );
  const failing = new Set((await scenesNeedingRegeneration(planId)).map((s) => s.scene.id));
  return {
    bible: loaded.plan.continuity,
    scenes: loaded.scenes.map((s) => ({
      id: s.scene.id,
      number: s.qc.number,
      title: s.scene.title,
      issues: s.state.issues,
      settled: settled(s.continuity),
      preflightCurrent: s.state.preflightCurrent,
      finalVision: s.scene.selectedAssetId
        ? visionStatus(finals.get(s.scene.selectedAssetId) ?? null, s.state.specHash, s.continuity.dismissed)
        : null,
      needsRegeneration: failing.has(s.scene.id),
    })),
  };
}

/** Everything the Shorts Studio shows about the story consistency of a Short's source clip. */
export async function getShortStoryQc(short: { sceneId: string | null; sourceAssetId: string | null }) {
  if (!short.sceneId) return null;
  const loaded = await loadSceneQc(short.sceneId);
  if (!loaded) return null;
  const s = loaded.current;
  const [asset] = short.sourceAssetId ? await db.select({ metadata: assets.metadata }).from(assets).where(eq(assets.id, short.sourceAssetId)) : [];
  const report = asset ? readVisionReport(asset.metadata) : null;
  return {
    sceneId: s.scene.id,
    planId: s.scene.planId,
    preflightIssues: s.state.issues,
    settled: settled(s.continuity),
    dismissed: s.continuity.dismissed,
    report,
    status: visionStatus(report, s.state.specHash, s.continuity.dismissed),
  };
}
