import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  AGE_GROUPS,
  CATEGORIES,
  IDEA_STATUSES,
  ORIGINALITY_STATUSES,
  PRIORITIES,
  VIDEO_FORMATS,
} from "../lib/ideas";
import {
  ASSET_KINDS,
  ASSET_SOURCES,
  ASSET_STATUSES,
  CHARACTER_STATUSES,
  JOB_MODES,
  JOB_STATUSES,
  PLAN_STATUSES,
  SCENE_STATUSES,
} from "../lib/production";
import { REVISION_SOURCES, STORY_STATUSES, type StoryContent, type StoryScene } from "../lib/stories";

export const ideaStatus = pgEnum("idea_status", IDEA_STATUSES);
export const ageGroup = pgEnum("age_group", AGE_GROUPS);
export const videoFormat = pgEnum("video_format", VIDEO_FORMATS);
export const priority = pgEnum("priority", PRIORITIES);
export const category = pgEnum("idea_category", CATEGORIES);
export const originalityStatus = pgEnum("originality_status", ORIGINALITY_STATUSES);

export const ideas = pgTable(
  "ideas",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    description: text().notNull().default(""),
    category: category().notNull().default("other"),
    sourceUrl: text(),
    status: ideaStatus().notNull().default("draft"),
    originalityStatus: originalityStatus().notNull().default("not_reviewed"),
    ageGroup: ageGroup().notNull().default("3-5"),
    format: videoFormat().notNull().default("standard"),
    priority: priority().notNull().default("medium"),
    tags: text().array().notNull().default([]),
    notes: text().notNull().default(""),
    // YouTube compliance: COPPA "made for kids" and altered/synthetic content disclosure.
    madeForKids: boolean().notNull().default(true),
    containsSyntheticMedia: boolean().notNull().default(true),
    // Demo rows created by "Load sample ideas"; removable in one click from Settings.
    isSample: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.status), index().on(t.createdAt)],
);

export type Idea = typeof ideas.$inferSelect;
export type NewIdea = typeof ideas.$inferInsert;

export const storyStatus = pgEnum("story_status", STORY_STATUSES);
export const revisionSource = pgEnum("revision_source", REVISION_SOURCES);

export const stories = pgTable(
  "stories",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Optional link to the idea the story was developed from.
    ideaId: uuid().references(() => ideas.id, { onDelete: "set null" }),
    title: text().notNull(),
    ageGroup: ageGroup().notNull(),
    topic: text().notNull(),
    learningObjective: text().notNull(),
    characters: text().notNull().default(""),
    targetDurationSeconds: integer().notNull(),
    tone: text().notNull(),
    visualStyle: text().notNull(),
    language: text().notNull().default("English"),
    notes: text().notNull().default(""),
    status: storyStatus().notNull().default("draft"),
    // Latest revision's content, denormalised so pages don't need to join the history.
    content: jsonb().$type<StoryContent>(),
    approvedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.status), index().on(t.updatedAt), index().on(t.ideaId)],
);

// One row per Claude API call, successful or not, so token usage is never under-reported.
export const storyGenerations = pgTable(
  "story_generations",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    ok: boolean().notNull(),
    model: text().notNull(),
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),
    durationMs: integer().notNull(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.storyId)],
);

export const storyRevisions = pgTable(
  "story_revisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    source: revisionSource().notNull(),
    content: jsonb().$type<StoryContent>().notNull(),
    generationId: uuid().references(() => storyGenerations.id, { onDelete: "set null" }),
    // Revision notes given to Claude when regenerating.
    instructions: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.storyId, t.number)],
);

export type Story = typeof stories.$inferSelect;
export type StoryRevision = typeof storyRevisions.$inferSelect;
export type StoryGeneration = typeof storyGenerations.$inferSelect;

// ---------- Production Studio ----------

export const planStatus = pgEnum("plan_status", PLAN_STATUSES);
export const sceneStatus = pgEnum("scene_status", SCENE_STATUSES);
export const jobMode = pgEnum("job_mode", JOB_MODES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const assetKind = pgEnum("asset_kind", ASSET_KINDS);
export const assetStatus = pgEnum("asset_status", ASSET_STATUSES);
export const assetSource = pgEnum("asset_source", ASSET_SOURCES);
export const characterStatus = pgEnum("character_status", CHARACTER_STATUSES);

// Reusable character bible shared across stories and episodes.
export const characters = pgTable(
  "characters",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    role: text().notNull().default(""),
    description: text().notNull().default(""),
    // Canonical look, appended to every prompt the character appears in.
    visualDescription: text().notNull(),
    notes: text().notNull().default(""),
    status: characterStatus().notNull().default("draft"),
    primaryReferenceId: uuid().references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.status)],
);

export const storyCharacters = pgTable(
  "story_characters",
  {
    storyId: uuid()
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    characterId: uuid()
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.characterId] }), index().on(t.characterId)],
);

export const productionPlans = pgTable(
  "production_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Kept when the story is deleted so production work is never lost.
    storyId: uuid().references(() => stories.id, { onDelete: "set null" }),
    title: text().notNull(),
    visualStyle: text().notNull().default(""),
    status: planStatus().notNull().default("planning"),
    aspectRatio: text().notNull().default("16:9"),
    imageModel: text().notNull(),
    videoModel: text().notNull(),
    // Story revision the scenes were imported from.
    sourceRevision: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex().on(t.storyId), index().on(t.updatedAt)],
);

export const productionScenes = pgTable(
  "production_scenes",
  {
    id: uuid().primaryKey().defaultRandom(),
    planId: uuid()
      .notNull()
      .references(() => productionPlans.id, { onDelete: "cascade" }),
    // 0-based order; the scene number shown in the UI is position + 1.
    position: integer().notNull(),
    title: text().notNull(),
    setting: text().notNull().default(""),
    action: text().notNull().default(""),
    narration: text().notNull().default(""),
    dialogue: jsonb().$type<StoryScene["dialogue"]>().notNull().default([]),
    durationSeconds: integer().notNull(),
    visualPrompt: text().notNull().default(""),
    negativePrompt: text().notNull().default(""),
    // Character names from the story that didn't match a library character.
    unmatchedCharacters: text().array().notNull().default([]),
    notes: text().notNull().default(""),
    status: sceneStatus().notNull().default("ready"),
    error: text(),
    selectedAssetId: uuid().references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index().on(t.planId, t.position)],
);

export const sceneCharacters = pgTable(
  "scene_characters",
  {
    sceneId: uuid()
      .notNull()
      .references(() => productionScenes.id, { onDelete: "cascade" }),
    characterId: uuid()
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.sceneId, t.characterId] }), index().on(t.characterId)],
);

// One row per generation attempt: automated (Higgsfield API) or manual (made in the Higgsfield
// web app and imported). A retry is a new row linked to the attempt it retries.
export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    sceneId: uuid()
      .notNull()
      .references(() => productionScenes.id, { onDelete: "cascade" }),
    mode: jobMode().notNull(),
    provider: text().notNull().default("higgsfield"),
    model: text(),
    outputKind: assetKind().notNull(),
    status: jobStatus().notNull(),
    prompt: text().notNull(),
    negativePrompt: text(),
    // Exact request body sent to the provider.
    request: jsonb().$type<Record<string, unknown>>(),
    externalRequestId: text(),
    idempotencyKey: uuid(),
    estimatedCostUsd: numeric({ precision: 10, scale: 4 }),
    attempt: integer().notNull().default(1),
    retryOfId: uuid().references((): AnyPgColumn => generationJobs.id, { onDelete: "set null" }),
    error: text(),
    submittedAt: timestamp({ withTimezone: true }),
    lastCheckedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    // When the provider deletes the outputs.
    outputExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.sceneId), index().on(t.status)],
);

// Images and clips: scene outputs and character reference images. Files live under MEDIA_DIR.
export const assets = pgTable(
  "assets",
  {
    id: uuid().primaryKey().defaultRandom(),
    sceneId: uuid().references((): AnyPgColumn => productionScenes.id, { onDelete: "cascade" }),
    characterId: uuid().references((): AnyPgColumn => characters.id, { onDelete: "cascade" }),
    jobId: uuid().references(() => generationJobs.id, { onDelete: "set null" }),
    kind: assetKind().notNull(),
    source: assetSource().notNull(),
    provider: text().notNull(),
    model: text(),
    status: assetStatus().notNull().default("pending_review"),
    // Relative to MEDIA_DIR; null when the file couldn't be downloaded.
    filePath: text(),
    originalName: text(),
    // Where the file came from (provider CDN or pasted URL). Provider URLs expire.
    sourceUrl: text(),
    contentType: text(),
    sizeBytes: integer(),
    durationSeconds: numeric({ precision: 8, scale: 2 }),
    prompt: text(),
    // Per-scene revision counter, so replacements keep their originals.
    revision: integer().notNull().default(1),
    replacesId: uuid().references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    reviewNotes: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    metadata: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.sceneId), index().on(t.characterId), index().on(t.status), index().on(t.createdAt)],
);

export type Character = typeof characters.$inferSelect;
export type ProductionPlan = typeof productionPlans.$inferSelect;
export type ProductionScene = typeof productionScenes.$inferSelect;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type Asset = typeof assets.$inferSelect;
