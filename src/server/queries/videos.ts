import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { assets, ideas, productionPlans, productionScenes, stories, type Video, videos } from "@/db/schema";
import { type VideoQualityInput, videoRenderKey } from "@/lib/long-video";
import { QUEUE_STATUSES } from "@/lib/shorts";

/** A render that started this long ago without finishing is treated as abandoned (e.g. a server restart). */
export const RENDER_STALE_MS = 65 * 60_000;

export function isRenderRunning(video: Pick<Video, "renderStartedAt">, now = Date.now()) {
  return video.renderStartedAt !== null && now - video.renderStartedAt.getTime() < RENDER_STALE_MS;
}

export async function listVideos() {
  return db
    .select({ video: videos, planTitle: productionPlans.title })
    .from(videos)
    .leftJoin(productionPlans, eq(videos.planId, productionPlans.id))
    .orderBy(desc(videos.updatedAt));
}

/** Scenes whose final clip is an approved video stored on disk, grouped by plan in scene order. */
export async function getSceneClips(planId?: string) {
  const rows = await db
    .select({
      planId: productionPlans.id,
      planTitle: productionPlans.title,
      sceneId: productionScenes.id,
      position: productionScenes.position,
      title: productionScenes.title,
      assetId: assets.id,
      filePath: assets.filePath,
      durationSeconds: assets.durationSeconds,
    })
    .from(productionScenes)
    .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
    .innerJoin(assets, eq(productionScenes.selectedAssetId, assets.id))
    .where(
      and(
        eq(assets.kind, "video"),
        eq(assets.status, "approved"),
        isNotNull(assets.filePath),
        planId ? eq(productionPlans.id, planId) : undefined,
      ),
    )
    .orderBy(asc(productionPlans.title), asc(productionScenes.position), asc(productionScenes.createdAt));

  const plans = new Map<string, { id: string; title: string; scenes: Omit<(typeof rows)[number], "planId" | "planTitle">[] }>();
  for (const { planId: id, planTitle, ...scene } of rows) {
    if (!plans.has(id)) plans.set(id, { id, title: planTitle, scenes: [] });
    plans.get(id)!.scenes.push(scene);
  }
  return [...plans.values()];
}

export type SceneClipPlans = Awaited<ReturnType<typeof getSceneClips>>;

export async function getVideo(id: string) {
  const [row] = await db
    .select({
      video: videos,
      plan: { id: productionPlans.id, title: productionPlans.title },
      story: { id: stories.id, title: stories.title, language: stories.language, ageGroup: stories.ageGroup, content: stories.content },
      idea: { madeForKids: ideas.madeForKids, containsSyntheticMedia: ideas.containsSyntheticMedia },
    })
    .from(videos)
    .leftJoin(productionPlans, eq(videos.planId, productionPlans.id))
    .leftJoin(stories, eq(videos.storyId, stories.id))
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .where(eq(videos.id, id));
  if (!row) return null;

  const [available] = row.video.planId ? await getSceneClips(row.video.planId) : [];
  const current = new Map((available?.scenes ?? []).map((s) => [s.sceneId, s.assetId]));
  return {
    ...row.video,
    plan: row.plan?.id ? row.plan : null,
    story: row.story?.id ? row.story : null,
    madeForKids: row.idea?.madeForKids ?? true,
    containsSyntheticMedia: row.idea?.containsSyntheticMedia ?? true,
    /** The plan's scenes with an approved clip, to add back to the timeline. */
    sceneClips: available?.scenes ?? [],
    /** Clips whose scene got a different final clip in the Production Studio after it was added. */
    replacedClips: row.video.clips.filter((c) => c.sceneId && current.has(c.sceneId) && current.get(c.sceneId) !== c.assetId).map((c) => c.assetId),
  };
}

export type VideoDetail = NonNullable<Awaited<ReturnType<typeof getVideo>>>;

export function isVideoRenderCurrent(video: Pick<Video, "renderFilePath" | "renderKey" | "clips" | "editSettings">) {
  return Boolean(video.renderFilePath) && video.renderKey === videoRenderKey(video.clips, video.editSettings);
}

export function buildVideoQualityInput(video: Video, ffmpegAvailable: boolean): VideoQualityInput {
  return {
    clips: video.clips,
    settings: video.editSettings,
    rendered: Boolean(video.renderFilePath),
    renderCurrent: isVideoRenderCurrent(video),
    outputProbe: video.outputProbe,
    outputAudio: video.outputAudio,
    captionsReviewed: video.captionsReviewed,
    metadata: { title: video.title, description: video.description, hashtags: video.hashtags },
    metadataApproved: Boolean(video.metadataApprovedAt),
    ffmpegAvailable,
  };
}

export async function getVideoPublishingQueue() {
  return db
    .select({
      video: videos,
      planTitle: productionPlans.title,
      storyLanguage: stories.language,
      madeForKids: ideas.madeForKids,
      containsSyntheticMedia: ideas.containsSyntheticMedia,
    })
    .from(videos)
    .leftJoin(productionPlans, eq(videos.planId, productionPlans.id))
    .leftJoin(stories, eq(videos.storyId, stories.id))
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .where(inArray(videos.status, [...QUEUE_STATUSES]))
    .orderBy(sql`${videos.scheduledAt} asc nulls last`, desc(videos.updatedAt));
}

/** A video plus the story language and compliance flags its YouTube metadata needs. */
export async function getVideoPublishContext(id: string) {
  const [row] = await db
    .select({
      video: videos,
      storyLanguage: stories.language,
      madeForKids: ideas.madeForKids,
      containsSyntheticMedia: ideas.containsSyntheticMedia,
    })
    .from(videos)
    .leftJoin(stories, eq(videos.storyId, stories.id))
    .leftJoin(ideas, eq(stories.ideaId, ideas.id))
    .where(eq(videos.id, id));
  return row ?? null;
}
