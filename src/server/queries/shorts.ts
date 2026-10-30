import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  assets,
  ideas,
  productionPlans,
  productionScenes,
  type Short,
  shortGenerations,
  shortMetrics,
  shorts,
  stories,
} from "@/db/schema";
import { type QualityInput } from "@/lib/short-qc";
import { QUEUE_STATUSES, renderKey } from "@/lib/shorts";

const orderBy = [
  asc(shorts.planId),
  sql`${shorts.publishOrder} asc nulls last`,
  asc(shorts.sceneNumber),
  asc(shorts.createdAt),
] as const;

export async function listShorts() {
  return db
    .select({
      short: shorts,
      planTitle: productionPlans.title,
      currentAssetId: productionScenes.selectedAssetId,
    })
    .from(shorts)
    .leftJoin(productionPlans, eq(shorts.planId, productionPlans.id))
    .leftJoin(productionScenes, eq(shorts.sceneId, productionScenes.id))
    .orderBy(...orderBy);
}

/** Scenes whose final clip is an approved video stored on disk, grouped by plan. */
export async function getImportCandidates() {
  const rows = await db
    .select({
      planId: productionPlans.id,
      planTitle: productionPlans.title,
      sceneId: productionScenes.id,
      position: productionScenes.position,
      title: productionScenes.title,
      durationSeconds: assets.durationSeconds,
      shortId: shorts.id,
    })
    .from(productionScenes)
    .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
    .innerJoin(assets, eq(productionScenes.selectedAssetId, assets.id))
    .leftJoin(shorts, eq(shorts.sceneId, productionScenes.id))
    .where(and(eq(assets.kind, "video"), eq(assets.status, "approved"), isNotNull(assets.filePath)))
    .orderBy(asc(productionPlans.title), asc(productionScenes.position));

  const plans = new Map<string, { id: string; title: string; scenes: Omit<(typeof rows)[number], "planId" | "planTitle">[] }>();
  for (const { planId, planTitle, ...scene } of rows) {
    if (!plans.has(planId)) plans.set(planId, { id: planId, title: planTitle, scenes: [] });
    plans.get(planId)!.scenes.push(scene);
  }
  return [...plans.values()];
}

export type ImportCandidates = Awaited<ReturnType<typeof getImportCandidates>>;

export async function getShort(id: string) {
  const [row] = await db
    .select({
      short: shorts,
      plan: { id: productionPlans.id, title: productionPlans.title },
      story: {
        id: stories.id,
        title: stories.title,
        ageGroup: stories.ageGroup,
        language: stories.language,
        content: stories.content,
      },
      idea: { madeForKids: ideas.madeForKids, containsSyntheticMedia: ideas.containsSyntheticMedia },
      scene: {
        id: productionScenes.id,
        position: productionScenes.position,
        title: productionScenes.title,
        setting: productionScenes.setting,
        action: productionScenes.action,
        narration: productionScenes.narration,
        dialogue: productionScenes.dialogue,
        selectedAssetId: productionScenes.selectedAssetId,
      },
    })
    .from(shorts)
    .leftJoin(productionPlans, eq(shorts.planId, productionPlans.id))
    .leftJoin(stories, eq(shorts.storyId, stories.id))
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .leftJoin(productionScenes, eq(shorts.sceneId, productionScenes.id))
    .where(eq(shorts.id, id));
  if (!row) return null;

  const [siblings, generations, currentAsset] = await Promise.all([
    row.short.planId
      ? db
          .select({ id: productionScenes.id, title: productionScenes.title, action: productionScenes.action })
          .from(productionScenes)
          .where(eq(productionScenes.planId, row.short.planId))
          .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt))
      : Promise.resolve([]),
    db.select().from(shortGenerations).where(eq(shortGenerations.shortId, id)).orderBy(desc(shortGenerations.createdAt)).limit(10),
    row.scene?.selectedAssetId
      ? db
          .select({ id: assets.id, filePath: assets.filePath, kind: assets.kind, status: assets.status })
          .from(assets)
          .where(eq(assets.id, row.scene.selectedAssetId))
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const index = row.scene ? siblings.findIndex((s) => s.id === row.scene!.id) : -1;
  return {
    ...row.short,
    plan: row.plan?.id ? row.plan : null,
    story: row.story?.id ? row.story : null,
    madeForKids: row.idea?.madeForKids ?? true,
    containsSyntheticMedia: row.idea?.containsSyntheticMedia ?? true,
    scene: row.scene?.id ? row.scene : null,
    sceneCount: siblings.length,
    previousScene: index > 0 ? siblings[index - 1] : null,
    nextScene: index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null,
    generations,
    // The scene's final clip changed in the Production Studio after this Short was imported.
    sourceChanged: Boolean(
      currentAsset &&
        currentAsset.kind === "video" &&
        currentAsset.status === "approved" &&
        currentAsset.filePath &&
        currentAsset.id !== row.short.sourceAssetId,
    ),
  };
}

export type ShortDetail = NonNullable<Awaited<ReturnType<typeof getShort>>>;

export function isRenderCurrent(short: Pick<Short, "renderFilePath" | "renderKey" | "sourceFilePath" | "videoSettings" | "captions" | "hook" | "hookSeconds">) {
  return Boolean(short.renderFilePath) && short.renderKey === renderKey({ ...short, settings: short.videoSettings });
}

export function buildQualityInput(short: Short, options: { ffmpegAvailable: boolean; hasDialogue: boolean }): QualityInput {
  return {
    sourceProbe: short.sourceProbe,
    outputProbe: short.outputProbe,
    outputAudio: short.outputAudio,
    rendered: Boolean(short.renderFilePath),
    renderCurrent: isRenderCurrent(short),
    settings: short.videoSettings,
    captions: short.captions,
    captionsReviewed: short.captionsReviewed,
    hasDialogue: options.hasDialogue || short.captions.length > 0,
    hook: short.videoSettings.showHook ? short.hook : "",
    analysis: short.analysis,
    metadata: { title: short.title, description: short.description, hashtags: short.hashtags },
    metadataApproved: Boolean(short.metadataApprovedAt),
    ffmpegAvailable: options.ffmpegAvailable,
  };
}

export async function getPublishingQueue() {
  return db
    .select({
      short: shorts,
      planTitle: productionPlans.title,
      storyLanguage: stories.language,
      madeForKids: ideas.madeForKids,
      containsSyntheticMedia: ideas.containsSyntheticMedia,
    })
    .from(shorts)
    .leftJoin(productionPlans, eq(shorts.planId, productionPlans.id))
    .leftJoin(stories, eq(shorts.storyId, stories.id))
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .where(inArray(shorts.status, [...QUEUE_STATUSES]))
    .orderBy(sql`${shorts.scheduledAt} asc nulls last`, ...orderBy);
}

export async function getShortStatusCounts() {
  const rows = await db.select({ status: shorts.status, count: sql<number>`count(*)`.mapWith(Number) }).from(shorts).groupBy(shorts.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count])) as Partial<Record<Short["status"], number>>;
}

export async function getShortAnalytics() {
  const [list, metrics] = await Promise.all([
    db
      .select({
        id: shorts.id,
        title: shorts.title,
        status: shorts.status,
        sceneNumber: shorts.sceneNumber,
        publishedAt: shorts.publishedAt,
        youtubeUrl: shorts.youtubeUrl,
        durationSeconds: sql<number | null>`coalesce((${shorts.outputProbe}->>'durationSeconds')::float, (${shorts.sourceProbe}->>'durationSeconds')::float)`,
        planTitle: productionPlans.title,
      })
      .from(shorts)
      .leftJoin(productionPlans, eq(shorts.planId, productionPlans.id))
      .orderBy(...orderBy),
    db.select().from(shortMetrics).orderBy(desc(shortMetrics.capturedAt), desc(shortMetrics.createdAt)),
  ]);
  return list.map((s) => {
    const own = metrics.filter((m) => m.shortId === s.id);
    return { ...s, latest: own[0] ?? null, history: own };
  });
}
