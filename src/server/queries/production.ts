import "server-only";

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import {
  assets,
  characters,
  generationJobs,
  productionPlans,
  productionScenes,
  sceneCharacters,
  stories,
  storyCharacters,
} from "@/db/schema";
import type { AssetKind, AssetStatus } from "@/lib/production";

export async function listPlans() {
  const plans = await db
    .select({
      id: productionPlans.id,
      title: productionPlans.title,
      status: productionPlans.status,
      storyId: productionPlans.storyId,
      updatedAt: productionPlans.updatedAt,
    })
    .from(productionPlans)
    .orderBy(desc(productionPlans.updatedAt));
  if (plans.length === 0) return [];

  const sceneRows = await db
    .select({ planId: productionScenes.planId, status: productionScenes.status })
    .from(productionScenes)
    .where(
      inArray(
        productionScenes.planId,
        plans.map((p) => p.id),
      ),
    );
  return plans.map((plan) => ({ ...plan, scenes: sceneRows.filter((s) => s.planId === plan.id) }));
}

/** Approved stories that don't have a production plan yet. */
export async function getStoriesReadyForProduction() {
  return db
    .select({
      id: stories.id,
      title: stories.title,
      generatedTitle: sql<string | null>`${stories.content}->>'title'`,
      sceneCount: sql<number>`coalesce(jsonb_array_length(${stories.content}->'scenes'), 0)`.mapWith(Number),
      approvedAt: stories.approvedAt,
    })
    .from(stories)
    .leftJoin(productionPlans, eq(productionPlans.storyId, stories.id))
    .where(and(eq(stories.status, "approved"), isNotNull(stories.content), isNull(productionPlans.id)))
    .orderBy(desc(stories.approvedAt));
}

export async function getStoriesAwaitingApprovalCount() {
  const [row] = await db
    .select({ count: count() })
    .from(stories)
    .where(and(eq(stories.status, "review"), isNotNull(stories.content)));
  return row?.count ?? 0;
}

const selectedAsset = alias(assets, "selected_asset");

export async function getPlan(id: string) {
  const [row] = await db
    .select({ plan: productionPlans, story: { id: stories.id, title: stories.title, status: stories.status } })
    .from(productionPlans)
    .leftJoin(stories, eq(productionPlans.storyId, stories.id))
    .where(eq(productionPlans.id, id));
  if (!row) return null;

  const [scenes, links, jobs] = await Promise.all([
    db
      .select({
        scene: productionScenes,
        selected: {
          id: selectedAsset.id,
          kind: selectedAsset.kind,
          filePath: selectedAsset.filePath,
          sourceUrl: selectedAsset.sourceUrl,
        },
      })
      .from(productionScenes)
      .leftJoin(selectedAsset, eq(productionScenes.selectedAssetId, selectedAsset.id))
      .where(eq(productionScenes.planId, id))
      .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt)),
    db
      .select({ sceneId: sceneCharacters.sceneId, name: characters.name })
      .from(sceneCharacters)
      .innerJoin(characters, eq(sceneCharacters.characterId, characters.id))
      .innerJoin(productionScenes, eq(sceneCharacters.sceneId, productionScenes.id))
      .where(eq(productionScenes.planId, id)),
    db
      .select({
        sceneId: generationJobs.sceneId,
        mode: generationJobs.mode,
        status: generationJobs.status,
        estimatedCostUsd: generationJobs.estimatedCostUsd,
      })
      .from(generationJobs)
      .innerJoin(productionScenes, eq(generationJobs.sceneId, productionScenes.id))
      .where(eq(productionScenes.planId, id)),
  ]);

  return {
    ...row.plan,
    story: row.story,
    jobs,
    scenes: scenes.map(({ scene, selected }) => ({
      ...scene,
      selected: selected?.id ? selected : null,
      characterNames: links.filter((l) => l.sceneId === scene.id).map((l) => l.name),
    })),
  };
}

export type PlanDetail = NonNullable<Awaited<ReturnType<typeof getPlan>>>;

export async function getScene(sceneId: string) {
  const [row] = await db
    .select({ scene: productionScenes, plan: productionPlans })
    .from(productionScenes)
    .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
    .where(eq(productionScenes.id, sceneId));
  if (!row) return null;

  const [siblings, linked, jobs, sceneAssets] = await Promise.all([
    db
      .select({ id: productionScenes.id, title: productionScenes.title })
      .from(productionScenes)
      .where(eq(productionScenes.planId, row.plan.id))
      .orderBy(asc(productionScenes.position), asc(productionScenes.createdAt)),
    db
      .select({ characterId: sceneCharacters.characterId })
      .from(sceneCharacters)
      .where(eq(sceneCharacters.sceneId, sceneId)),
    db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.sceneId, sceneId))
      .orderBy(desc(generationJobs.createdAt)),
    db
      .select()
      .from(assets)
      .where(eq(assets.sceneId, sceneId))
      .orderBy(desc(assets.revision), desc(assets.createdAt)),
  ]);

  const characterIds = linked.map((l) => l.characterId);
  // Approved reference images of this scene's characters can be used as start frames.
  const references = characterIds.length
    ? await db
        .select({
          id: assets.id,
          filePath: assets.filePath,
          characterId: assets.characterId,
          characterName: characters.name,
        })
        .from(assets)
        .innerJoin(characters, eq(assets.characterId, characters.id))
        .where(and(inArray(assets.characterId, characterIds), eq(assets.status, "approved"), eq(assets.kind, "image")))
    : [];

  const index = siblings.findIndex((s) => s.id === sceneId);
  return {
    ...row,
    number: index + 1,
    total: siblings.length,
    previousId: siblings[index - 1]?.id ?? null,
    nextId: siblings[index + 1]?.id ?? null,
    characterIds,
    jobs,
    assets: sceneAssets,
    references,
  };
}

export type SceneDetail = NonNullable<Awaited<ReturnType<typeof getScene>>>;

export type AssetFilters = { status?: AssetStatus; kind?: AssetKind; planId?: string };

export async function listAssets(filters: AssetFilters) {
  const where: SQL[] = [isNotNull(assets.sceneId)];
  if (filters.status) where.push(eq(assets.status, filters.status));
  if (filters.kind) where.push(eq(assets.kind, filters.kind));
  if (filters.planId) where.push(eq(productionScenes.planId, filters.planId));

  return db
    .select({
      asset: assets,
      sceneId: productionScenes.id,
      sceneTitle: productionScenes.title,
      scenePosition: productionScenes.position,
      isSelected: sql<boolean>`${productionScenes.selectedAssetId} = ${assets.id}`,
      planId: productionPlans.id,
      planTitle: productionPlans.title,
    })
    .from(assets)
    .innerJoin(productionScenes, eq(assets.sceneId, productionScenes.id))
    .innerJoin(productionPlans, eq(productionScenes.planId, productionPlans.id))
    .where(and(...where))
    .orderBy(desc(assets.createdAt))
    .limit(200);
}

export async function getPlanOptions() {
  return db
    .select({ id: productionPlans.id, title: productionPlans.title })
    .from(productionPlans)
    .orderBy(asc(productionPlans.title));
}

export async function getProductionSceneCounts() {
  const [row] = await db
    .select({
      total: count(),
      approved: sql<number>`count(*) filter (where ${productionScenes.status} = 'approved')`.mapWith(Number),
      review: sql<number>`count(*) filter (where ${productionScenes.status} = 'review')`.mapWith(Number),
    })
    .from(productionScenes);
  return row ?? { total: 0, approved: 0, review: 0 };
}

// ---------- Characters ----------

const primaryRef = alias(assets, "primary_ref");

export async function listCharacters() {
  const rows = await db
    .select({
      character: characters,
      primaryFilePath: primaryRef.filePath,
      referenceCount: sql<number>`(select count(*) from ${assets} where ${assets.characterId} = ${characters.id})`.mapWith(Number),
      storyCount: sql<number>`(select count(*) from ${storyCharacters} where ${storyCharacters.characterId} = ${characters.id})`.mapWith(Number),
      sceneCount: sql<number>`(select count(*) from ${sceneCharacters} where ${sceneCharacters.characterId} = ${characters.id})`.mapWith(Number),
    })
    .from(characters)
    .leftJoin(primaryRef, eq(characters.primaryReferenceId, primaryRef.id))
    .orderBy(asc(characters.status), asc(characters.name));
  return rows;
}

export async function getCharacter(id: string) {
  const [character] = await db.select().from(characters).where(eq(characters.id, id));
  if (!character) return null;
  const [references, appearances] = await Promise.all([
    db
      .select()
      .from(assets)
      .where(eq(assets.characterId, id))
      .orderBy(desc(assets.revision)),
    db
      .select({ storyId: stories.id, title: stories.title, generatedTitle: sql<string | null>`${stories.content}->>'title'` })
      .from(storyCharacters)
      .innerJoin(stories, eq(storyCharacters.storyId, stories.id))
      .where(eq(storyCharacters.characterId, id)),
  ]);
  return { ...character, references, appearances };
}

export async function getCharacterOptions() {
  return db
    .select({
      id: characters.id,
      name: characters.name,
      status: characters.status,
      visualDescription: characters.visualDescription,
    })
    .from(characters)
    .where(ne(characters.status, "archived"))
    .orderBy(asc(characters.name));
}

export type CharacterOption = Awaited<ReturnType<typeof getCharacterOptions>>[number];

export async function getPlanIdForStory(storyId: string) {
  const [row] = await db
    .select({ id: productionPlans.id })
    .from(productionPlans)
    .where(eq(productionPlans.storyId, storyId));
  return row?.id ?? null;
}
