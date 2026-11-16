import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import { db } from "@/db";
import { assets } from "@/db/schema";
import {
  evaluateKidsGate,
  type GateApproval,
  gateBlocker,
  type GateReview,
  gateReviewOutputSchema,
  type KidsGateContext,
  kidsGateModel as toGateModel,
  kidsGateRules,
  readGateState,
  toGateChecks,
} from "@/lib/generation-qc";
import { getHiggsfieldModel } from "@/lib/higgsfield";
import { describeKlingFrames, readSceneFrames } from "@/lib/kling";
import { formatDialogue } from "@/lib/stories";
import { describeShots, formatSeconds, readVisionReport, visionStatus } from "@/lib/story-qc";
import { getClaudeClient, getClaudeConfig, NOT_CONFIGURED_MESSAGE, runStructuredGeneration } from "@/server/ai/claude";
import { buildGateReviewText, gateReviewSystemPrompt } from "@/server/ai/gate-prompt";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { buildSceneClipPrompt, loadSceneForGeneration, pickCharacterReferences } from "@/server/production/service";

import { generationBlockers, loadSceneQc, logUsage, type QcResult, referenceImage, sceneContentKey, updateSceneContinuity } from "./service";

// Pre-generation QC for Kids Studio clips (see @/lib/generation-qc): the gate context, the Claude frame
// review, approvals, and the check every video submission runs.

type Asset = typeof assets.$inferSelect;

const MAX_CHARACTER_REFS = 3;
const MAX_SCENE_REFS = 2;

/** Everything the gate needs about a scene, plus the loaded rows for the review. */
export async function loadKidsGate(sceneId: string) {
  const loaded = await loadSceneQc(sceneId);
  if (!loaded) return null;
  const s = loaded.current;
  const linked = loaded.links.filter((l) => l.sceneId === sceneId);
  const refIds = s.continuity.referenceAssetIds;
  const frames = readSceneFrames(s.continuity);
  const frameIds = [...frames.middleAssetIds, ...(frames.endAssetId ? [frames.endAssetId] : [])];

  const [sceneAssets, characterRefs, picked, frameRows] = await Promise.all([
    db.select().from(assets).where(eq(assets.sceneId, sceneId)).orderBy(desc(assets.revision)),
    linked.length
      ? db
          .select()
          .from(assets)
          .where(and(inArray(assets.characterId, linked.map((l) => l.id)), eq(assets.kind, "image"), eq(assets.status, "approved")))
          .orderBy(desc(assets.revision))
      : Promise.resolve([] as Asset[]),
    refIds.length ? db.select().from(assets).where(and(inArray(assets.id, refIds), ne(assets.status, "rejected"))) : Promise.resolve([] as Asset[]),
    frameIds.length
      ? db.select().from(assets).where(and(inArray(assets.id, frameIds), eq(assets.kind, "image"), ne(assets.status, "rejected")))
      : Promise.resolve([] as Asset[]),
  ]);

  const startImages: KidsGateContext["startImages"] = {};
  for (const a of sceneAssets.filter((x) => x.kind === "image" && x.status === "approved")) {
    const lastOf = a.metadata?.lastFrameOfScene;
    startImages[a.id] = {
      label: lastOf !== undefined ? `Last frame of scene ${lastOf} r${a.revision}` : `Scene keyframe r${a.revision}`,
      sceneKeyframe: lastOf === undefined,
      contentType: a.contentType,
    };
  }
  for (const a of characterRefs) {
    if (startImages[a.id]) continue;
    const name = linked.find((l) => l.id === a.characterId)?.name ?? "Character";
    startImages[a.id] = { label: `${name} reference r${a.revision}`, sceneKeyframe: false, contentType: a.contentType };
  }
  for (const a of picked.filter((x) => x.kind === "image")) {
    if (!startImages[a.id]) startImages[a.id] = { label: `Scene reference r${a.revision}`, sceneKeyframe: false, contentType: a.contentType };
  }

  const latestClip = sceneAssets.find((a) => a.kind === "video" && a.filePath);
  const report = latestClip ? readVisionReport(latestClip.metadata) : null;
  const inspection = latestClip ? visionStatus(report, s.state.specHash, s.continuity.dismissed) : null;

  const ctx: KidsGateContext = {
    contentKey: sceneContentKey(s, loaded.plan),
    durationSeconds: s.scene.durationSeconds,
    action: s.scene.action,
    startImages,
    frames: {
      middle: frames.middleAssetIds.length,
      end: Boolean(frames.endAssetId),
      missing: frameIds.filter((id) => !frameRows.some((r) => r.id === id)).length,
    },
    storyQc: {
      openCritical: generationBlockers(s).map((i) => i.message),
      preflightCurrent: s.state.preflightCurrent,
      preflightStale: s.state.preflightStale,
    },
    previousClip: latestClip
      ? { revision: latestClip.revision, inspection: inspection === "unchecked" || inspection === null ? "none" : inspection }
      : null,
    aiConfigured: getClaudeConfig().configured,
    state: readGateState(s.continuity.gate),
    dismissed: s.continuity.dismissed,
  };
  return { ctx, loaded, s, sceneAssets, characterRefs, picked, frameRows, frames, latestClip, report };
}

function resolveModel(modelId: string | null) {
  if (modelId === null) return { model: null };
  const model = getHiggsfieldModel(modelId);
  if (!model || model.output !== "video") return { error: "Choose a supported video model" };
  return { model };
}

/** The gate for one clip request; `modelId` null is Hedra (any reviewed model counts). */
export async function sceneVideoGate(sceneId: string, modelId: string | null, startAssetId: string | null) {
  const gate = await loadKidsGate(sceneId);
  if (!gate) return null;
  const resolved = resolveModel(modelId);
  if ("error" in resolved) return null;
  const gm = resolved.model ? toGateModel(resolved.model, gate.ctx.durationSeconds) : null;
  return { gate, model: gm, evaluation: evaluateKidsGate(gate.ctx, gm, startAssetId) };
}

/** Why this clip can't be generated yet, or null. Every paid video submission calls this. */
export async function sceneVideoGateBlocker(sceneId: string, modelId: string | null, startAssetId: string | null) {
  const result = await sceneVideoGate(sceneId, modelId, startAssetId);
  if (!result) return "Scene or model not found";
  return gateBlocker(result.evaluation);
}

/** The approved model and start image of a scene, for resubmitting failed clips; or why there is none. */
export async function approvedRequest(sceneId: string): Promise<{ modelId: string; startAssetId: string | null } | { problem: string }> {
  const gate = await loadKidsGate(sceneId);
  if (!gate) return { problem: "Scene not found" };
  const approval = gate.ctx.state.approval;
  if (!approval?.modelId || approval.contentKey !== gate.ctx.contentKey) {
    return { problem: "apply the corrections, run the pre-generation review and approve the new version on the scene page" };
  }
  const blocker = await sceneVideoGateBlocker(sceneId, approval.modelId, approval.startAssetId);
  return blocker ? { problem: blocker } : { modelId: approval.modelId, startAssetId: approval.startAssetId };
}

const isReviewRule = (label: string) => label.startsWith("AI review");

/**
 * One Claude call that looks at the start, middle and end frames and the references, reads the exact
 * clip prompt and the script, and reports what would go wrong. Refuses (without calling Claude) while a
 * hard rule problem would make the request change anyway.
 */
export async function runSceneGateReview(sceneId: string, modelId: string, startAssetId: string | null): Promise<QcResult> {
  const resolved = resolveModel(modelId);
  if ("error" in resolved || !resolved.model) return { ok: false, message: "Choose a supported video model" };
  const model = resolved.model;
  const gate = await loadKidsGate(sceneId);
  if (!gate) return { ok: false, message: "Scene not found" };
  const { ctx, s, loaded } = gate;
  const gm = toGateModel(model, ctx.durationSeconds);
  const needsStart = model.input === "image";
  const start = needsStart ? startAssetId : null;

  const hard = kidsGateRules(ctx, gm, start).filter((c) => c.hard && c.status === "critical" && !isReviewRule(c.label));
  if (hard.length) return { ok: false, message: `Fix this first (no review was run, so nothing was charged): ${hard[0].label}. ${hard[0].fix ?? hard[0].detail}` };

  const client = getClaudeClient();
  if (!client) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  const generation = await loadSceneForGeneration(sceneId);
  if (!generation) return { ok: false, message: "Scene not found" };

  // Frames in clip order, then character and scene references.
  const byId = new Map<string, Asset>([...gate.sceneAssets, ...gate.characterRefs, ...gate.picked, ...gate.frameRows].map((a) => [a.id, a]));
  const images: { label: string; asset: Asset }[] = [];
  if (start) {
    const a = byId.get(start) ?? (await db.select().from(assets).where(eq(assets.id, start)))[0];
    if (a) images.push({ label: `START frame (first frame of the clip): ${ctx.startImages[start]?.label ?? "start image"}`, asset: a });
  }
  if (needsStart && gm.keyframes) {
    gate.frames.middleAssetIds.forEach((id, i) => {
      const a = byId.get(id);
      if (a) images.push({ label: `MIDDLE frame ${i + 1} of ${gate.frames.middleAssetIds.length} (the clip passes through it in order)`, asset: a });
    });
    const end = gate.frames.endAssetId && byId.get(gate.frames.endAssetId);
    if (end) images.push({ label: "END frame (last frame of the clip)", asset: end });
  }
  const linked = loaded.links.filter((l) => l.sceneId === sceneId);
  const charRefs = (await pickCharacterReferences(linked, s.continuity.referenceAssetIds)).slice(0, MAX_CHARACTER_REFS);
  for (const r of charRefs) {
    if (!images.some((i) => i.asset.id === r.asset.id)) images.push({ label: `Character reference: ${r.names.join(" and ")}`, asset: r.asset });
  }
  for (const a of gate.picked.filter((p) => p.kind === "image" && !images.some((i) => i.asset.id === p.id)).slice(0, MAX_SCENE_REFS)) {
    images.push({ label: `Scene reference r${a.revision} (prop, place or style)`, asset: a });
  }

  const ffmpeg = Boolean(await getFfmpegVersion());
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const legend: string[] = [];
  for (const image of images) {
    const block = await referenceImage(image.asset, ffmpeg).catch(() => null);
    if (!block) {
      legend.push(`${image.label}: (could not be attached)`);
      continue;
    }
    legend.push(image.label);
    content.push({ type: "text", text: image.label }, block);
  }

  let prompt = await buildSceneClipPrompt(generation, model);
  if (needsStart && gm.keyframes) {
    const note = describeKlingFrames({ middle: gate.frames.middleAssetIds.length, end: Boolean(gate.frames.endAssetId) });
    if (note) prompt = `${prompt}\n\n${note}`;
  }
  const bible = loaded.plan.continuity?.bible;
  const shots = s.state.preflightCurrent ? (s.continuity.preflight?.shots ?? []) : [];
  const history = gate.report
    ? gate.report.issues
        .filter((i) => i.severity !== "info")
        .map((i) => `- Clip r${gate.latestClip!.revision}${i.timestamp != null ? ` at ${formatSeconds(i.timestamp)}` : ""} [${i.severity}]: ${i.message}${i.fix ? ` Fix: ${i.fix}` : ""}`)
    : [];
  const text = buildGateReviewText({
    title: `Scene ${s.qc.number}: ${s.scene.title}`,
    model: `${model.label} (${needsStart ? "animates the start frame" : "text to video"})`,
    clipSeconds: gm.requestedSeconds ?? ctx.durationSeconds,
    sceneSeconds: ctx.durationSeconds,
    frameLegend: legend,
    sceneLines: [
      `Characters: ${s.qc.characters.map((c) => `${c.name} (${c.visualDescription || "no description"})`).join("; ") || "(none)"}`,
      `Setting: ${s.scene.setting || "(none)"}`,
      `Action: ${s.scene.action || "(none)"}`,
      `Dialogue:\n${formatDialogue(s.scene.dialogue) || "(none)"}`,
      `Keyframe description (visual prompt): ${s.scene.visualPrompt || "(none)"}`,
      ...(shots.length ? [`Shot list from the story check:\n${describeShots(shots)}`] : []),
      ...(bible ? [`Continuity bible: ${bible.characters.map((c) => `${c.name}: ${c.appearance}; outfit ${c.outfit}`).join(" | ")}`] : []),
    ],
    prompt,
    ruleFindings: kidsGateRules(ctx, gm, start),
    history,
  });
  content.push({ type: "text", text });

  const config = getClaudeConfig();
  const result = await runStructuredGeneration(
    client,
    { system: gateReviewSystemPrompt("kids"), user: text, content, model: config.model, effort: config.effort, maxTokens: 16_000, subject: "pre-generation review" },
    gateReviewOutputSchema,
  );
  await logUsage(loaded.plan.id, "qc_gate", result);
  if (!result.ok) return { ok: false, message: result.message };

  const review: GateReview = {
    contentKey: ctx.contentKey,
    modelId: model.id,
    startAssetId: start,
    checkedAt: new Date().toISOString(),
    model: result.model,
    frames: result.data.frames,
    beats: result.data.beats,
    checks: toGateChecks(result.data.checks),
    promptAdditions: result.data.promptAdditions.trim(),
    suggestedPrompt: result.data.suggestedPrompt.trim(),
    summary: result.data.summary.trim(),
  };
  await updateSceneContinuity(sceneId, (c) => {
    const state = readGateState(c.gate);
    // A new review replaces the old one; an approval of a different version no longer applies.
    const approval = state.approval && state.approval.contentKey === review.contentKey ? state.approval : null;
    return { ...c, gate: { review, approval } };
  });
  const critical = review.checks.filter((c) => c.status === "critical").length;
  const warnings = review.checks.filter((c) => c.status === "warning").length;
  return {
    ok: true,
    message: critical
      ? `Review found ${critical} critical issue${critical === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}. Fix them before generating.`
      : `Review passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}. Check the report, then approve.`,
  };
}

/** A person approves (or withdraws approval of) this exact version for generation. */
export async function setSceneGateApproval(sceneId: string, modelId: string | null, startAssetId: string | null, approve: boolean): Promise<QcResult> {
  if (!approve) {
    const found = await updateSceneContinuity(sceneId, (c) => ({ ...c, gate: { ...readGateState(c.gate), approval: null } }));
    return found ? { ok: true, message: "Approval withdrawn" } : { ok: false, message: "Scene not found" };
  }
  const result = await sceneVideoGate(sceneId, modelId, startAssetId);
  if (!result) return { ok: false, message: "Scene or model not found" };
  const { evaluation, gate, model } = result;
  if (!evaluation.canApprove) return { ok: false, message: gateBlocker(evaluation) ?? "Resolve the critical issues first" };
  const needsStart = model ? model.input === "image" : true;
  const approval: GateApproval = {
    contentKey: gate.ctx.contentKey,
    modelId,
    startAssetId: needsStart ? startAssetId : null,
    approvedAt: new Date().toISOString(),
  };
  await updateSceneContinuity(sceneId, (c) => ({ ...c, gate: { ...readGateState(c.gate), approval } }));
  return { ok: true, message: "Version approved. You can generate it now; any edit needs a new review and approval." };
}
