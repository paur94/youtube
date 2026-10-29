import { z } from "zod";

import { parseDialogue, type StoryContent, type StoryScene } from "./stories";

// Shared by the DB schema, server actions, the generation queue and client components.
export const PLAN_STATUSES = ["planning", "in_production", "ready_for_assembly"] as const;
export const SCENE_STATUSES = ["draft", "ready", "generating", "review", "failed", "approved"] as const;
export const JOB_MODES = ["api", "manual"] as const;
export const JOB_STATUSES = [
  "awaiting_manual",
  "queued",
  "in_progress",
  "completed",
  "failed",
  "nsfw",
  "canceled",
  "timed_out",
] as const;
export const ASSET_KINDS = ["image", "video"] as const;
export const ASSET_STATUSES = ["pending_review", "approved", "rejected"] as const;
export const ASSET_SOURCES = ["higgsfield_api", "manual_import"] as const;
export const CHARACTER_STATUSES = ["draft", "approved", "archived"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type SceneStatus = (typeof SCENE_STATUSES)[number];
export type JobMode = (typeof JOB_MODES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type AssetSource = (typeof ASSET_SOURCES)[number];
export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  planning: "Planning",
  in_production: "In production",
  ready_for_assembly: "Ready for assembly",
};

export const SCENE_STATUS_LABELS: Record<SceneStatus, string> = {
  draft: "Needs prompt",
  ready: "Ready to generate",
  generating: "Generating",
  review: "Needs review",
  failed: "Failed",
  approved: "Approved",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  awaiting_manual: "Waiting for manual import",
  queued: "Queued",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  nsfw: "Blocked by moderation",
  canceled: "Canceled",
  timed_out: "Timed out",
};

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  pending_review: "Needs review",
  approved: "Approved",
  rejected: "Rejected",
};

export const ASSET_SOURCE_LABELS: Record<AssetSource, string> = {
  higgsfield_api: "Higgsfield API",
  manual_import: "Manual import",
};

export const CHARACTER_STATUS_LABELS: Record<CharacterStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  archived: "Archived",
};

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["awaiting_manual", "queued", "in_progress"];
export const FAILED_JOB_STATUSES: readonly JobStatus[] = ["failed", "nsfw", "timed_out"];
// Jobs whose remote state can still change and should be polled.
export const POLLABLE_JOB_STATUSES: readonly JobStatus[] = ["queued", "in_progress"];

/** API jobs still queued or running after this long are marked timed out. */
export const JOB_TIMEOUT_MS = 30 * 60_000;

export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

// Avoids common failure modes for children's content and keeps output free of IP and text.
export const DEFAULT_NEGATIVE_PROMPT =
  "text, letters, captions, watermark, logo, signature, brand names, existing cartoon characters, " +
  "celebrity likeness, scary, violent, dark horror lighting, blood, weapons, blurry, deformed hands, extra limbs";

// ---------- Scene status ----------

export function deriveSceneStatus(input: {
  visualPrompt: string;
  /** Newest first. */
  jobs: { status: JobStatus }[];
  assets: { status: AssetStatus }[];
  selectedAssetApproved: boolean;
}): SceneStatus {
  if (input.selectedAssetApproved) return "approved";
  if (input.assets.some((a) => a.status === "pending_review")) return "review";
  if (input.jobs.some((j) => ACTIVE_JOB_STATUSES.includes(j.status))) return "generating";
  const latest = input.jobs[0];
  if (latest && FAILED_JOB_STATUSES.includes(latest.status)) return "failed";
  if (!input.visualPrompt.trim()) return "draft";
  return "ready";
}

export type ProgressSummary = {
  total: number;
  approved: number;
  percent: number;
  counts: Record<SceneStatus, number>;
};

export function summarizeProgress(scenes: { status: SceneStatus }[]): ProgressSummary {
  const counts = Object.fromEntries(SCENE_STATUSES.map((s) => [s, 0])) as Record<SceneStatus, number>;
  for (const scene of scenes) counts[scene.status]++;
  const total = scenes.length;
  return {
    total,
    approved: counts.approved,
    percent: total ? Math.round((counts.approved / total) * 100) : 0,
    counts,
  };
}

/** True when every scene has an approved final asset; required before final assembly. */
export function isReadyForAssembly(scenes: { status: SceneStatus }[]) {
  return scenes.length > 0 && scenes.every((s) => s.status === "approved");
}

// ---------- Cost estimates ----------

export type CostSummary = {
  /** Sum of estimates for jobs that are or may be charged. Null when no job has an estimate. */
  estimatedUsd: number | null;
  estimatedJobs: number;
  /** API jobs without a price (the estimate endpoint returned nothing). */
  unpricedJobs: number;
  manualJobs: number;
};

// Higgsfield doesn't charge failed, moderated or canceled-before-start requests.
const UNCHARGED: readonly JobStatus[] = ["failed", "nsfw", "canceled"];

export function summarizeCosts(
  jobs: { mode: JobMode; status: JobStatus; estimatedCostUsd: string | null }[],
): CostSummary {
  let total = 0;
  let estimatedJobs = 0;
  let unpricedJobs = 0;
  let manualJobs = 0;
  for (const job of jobs) {
    if (job.mode === "manual") {
      manualJobs++;
      continue;
    }
    if (UNCHARGED.includes(job.status)) continue;
    const usd = job.estimatedCostUsd === null ? NaN : Number(job.estimatedCostUsd);
    if (Number.isFinite(usd)) {
      total += usd;
      estimatedJobs++;
    } else {
      unpricedJobs++;
    }
  }
  return { estimatedUsd: estimatedJobs ? total : null, estimatedJobs, unpricedJobs, manualJobs };
}

export function formatUsd(usd: number) {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

// ---------- Prompts ----------

export type PromptCharacter = { name: string; visualDescription: string };

/**
 * The text sent to the provider (or copied for manual generation): the scene's visual prompt,
 * the canonical look of every linked character so they stay consistent across scenes, and the
 * story's visual style when the prompt doesn't already mention it.
 */
export function buildGenerationPrompt(input: {
  visualPrompt: string;
  characters: PromptCharacter[];
  visualStyle?: string | null;
}) {
  const parts = [input.visualPrompt.trim()];
  const described = input.characters.filter((c) => c.visualDescription.trim());
  if (described.length) {
    parts.push(
      "Keep these characters exactly consistent: " +
        described.map((c) => `${c.name}: ${c.visualDescription.trim()}`).join(" "),
    );
  }
  const style = input.visualStyle?.trim();
  if (style && !input.visualPrompt.toLowerCase().includes(style.toLowerCase())) {
    parts.push(`Visual style: ${style}.`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Appended to the negative prompt when a video model voices the dialogue itself. */
export const DIALOGUE_NEGATIVE_PROMPT =
  "listener lip movement, silent character talking, two characters talking at once, wrong character speaking";

const NARRATOR = "Narrator";

/**
 * Spoken lines for video models that generate their own sound, quoted so the model voices them
 * word for word and lip-syncs the speaker. Each line names who stays silent, because models tend
 * to move the listener's mouth too, especially on a question that the listener answers next.
 * `onScreen` adds characters who are in the shot but have no lines.
 */
export function describeDialogue(lines: StoryScene["dialogue"], onScreen: string[] = []) {
  const spoken = lines
    .filter((d) => d.line.trim())
    .map((d) => ({ speaker: d.character.trim() || NARRATOR, line: d.line.trim() }));
  if (!spoken.length) return "";
  const present = [
    ...new Set([...onScreen.map((n) => n.trim()), ...spoken.map((d) => d.speaker)].filter(Boolean)),
  ].filter((n) => n.toLowerCase() !== NARRATOR.toLowerCase());

  const turns = spoken.map(({ speaker, line }) => {
    if (speaker.toLowerCase() === NARRATOR.toLowerCase()) {
      return `a voice-over narrator says, "${line}", and no one on screen moves their lips`;
    }
    const listeners = present.filter((n) => n !== speaker);
    const silent = listeners.length
      ? `, while ${joinNames(listeners)} ${listeners.length > 1 ? "listen" : "listens"} silently with mouth closed`
      : "";
    return `${speaker} says, "${line}"${silent}`;
  });
  return (
    "Audio: the characters speak these lines aloud, in this order, with matching lip movement on the speaker only: " +
    turns.join(". Then ") +
    ". Only one character speaks at a time; a character's lips move only during their own line."
  );
}

function joinNames(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/**
 * Tells a reference-image model which attached image shows which characters, in upload order.
 * One image can show several characters (e.g. an approved group keyframe).
 */
export function describeReferenceImages(images: string[][]) {
  if (!images.length) return "";
  const list = images.map((names, i) => `image ${i + 1} shows ${joinNames(names)}`).join("; ");
  return (
    `The attached reference images show the characters: ${list}. ` +
    "Keep each character's face, hair, proportions, colours and outfit exactly as in their reference image, " +
    "and place them in the new scene described above."
  );
}

// Names of well-known franchises, characters and studios that must not appear in prompts.
// Not exhaustive: the manual review step is still the real safeguard.
const PROTECTED_NAMES = [
  "disney",
  "pixar",
  "dreamworks",
  "ghibli",
  "miyazaki",
  "marvel",
  "dc comics",
  "pokemon",
  "pokémon",
  "pikachu",
  "peppa pig",
  "paw patrol",
  "bluey",
  "cocomelon",
  "pinkfong",
  "baby shark",
  "mickey mouse",
  "minnie mouse",
  "spongebob",
  "sesame street",
  "elmo",
  "barbie",
  "lego",
  "minecraft",
  "super mario",
  "sonic the hedgehog",
  "hello kitty",
  "batman",
  "superman",
  "spider-man",
  "spiderman",
  "harry potter",
  "shrek",
  "minions",
  "toy story",
  "thomas the tank engine",
  "teletubbies",
  "dora the explorer",
];

const STYLE_IMITATION = /\b(in the (art )?style of|inspired by the art of|drawn by|painted by|à la)\b/i;

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Problems that block automated generation until the prompt is edited. */
export function findPromptConcerns(text: string) {
  const concerns: string[] = [];
  const lower = text.toLowerCase();
  const names = PROTECTED_NAMES.filter((name) =>
    new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}($|[^\\p{L}])`, "u").test(lower),
  );
  if (names.length) {
    concerns.push(`Mentions existing franchises, characters or studios: ${names.join(", ")}`);
  }
  if (STYLE_IMITATION.test(text)) {
    concerns.push("Asks to imitate a specific artist or studio. Describe the look itself instead");
  }
  return concerns;
}

// ---------- Importing a story ----------

export type SceneDraft = {
  title: string;
  setting: string;
  action: string;
  narration: string;
  dialogue: StoryScene["dialogue"];
  durationSeconds: number;
  visualPrompt: string;
  negativePrompt: string;
  characterNames: string[];
};

export function clampDuration(seconds: number) {
  const n = Math.round(Number(seconds) || 0);
  return Math.min(600, Math.max(1, n || 5));
}

/** Story scenes in storyboard order, ready to insert as production scenes. */
export function scenesFromStory(content: Pick<StoryContent, "scenes">): SceneDraft[] {
  return [...content.scenes]
    .map((scene, index) => ({ scene, index }))
    .sort((a, b) => (Number(a.scene.number) || a.index) - (Number(b.scene.number) || b.index) || a.index - b.index)
    .map(({ scene }) => ({
      title: scene.title.trim() || "Untitled scene",
      setting: scene.setting,
      action: scene.action,
      narration: scene.narration,
      dialogue: scene.dialogue,
      durationSeconds: clampDuration(scene.durationSeconds),
      visualPrompt: scene.visualPrompt,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      characterNames: [...new Set(scene.characters.map((c) => c.trim()).filter(Boolean))],
    }));
}

export function normalizeName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Returns the new position order after moving one scene up or down. */
export function moveInOrder<T>(ids: T[], id: T, direction: "up" | "down") {
  const from = ids.indexOf(id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// ---------- Forms ----------

const text = (max: number) => z.string().trim().max(max).default("");

export const sceneInputSchema = z.object({
  title: z.string().trim().min(1, "Give the scene a title").max(160),
  setting: text(2000),
  action: text(4000),
  narration: text(8000),
  dialogue: text(8000).transform(parseDialogue),
  durationSeconds: z.coerce
    .number("Enter a duration")
    .int("Use whole seconds")
    .min(1, "At least 1 second")
    .max(600, "At most 10 minutes"),
  visualPrompt: text(6000),
  negativePrompt: text(2000),
  notes: text(2000),
  characterIds: z.array(z.uuid()).max(30).default([]),
});

export type SceneInput = z.infer<typeof sceneInputSchema>;
export type SceneFieldErrors = Partial<Record<keyof z.input<typeof sceneInputSchema>, string[]>>;
export type SceneFormState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: SceneFieldErrors } | null;

export function parseSceneForm(formData: FormData) {
  return sceneInputSchema.safeParse({
    title: formData.get("title") ?? "",
    setting: formData.get("setting") ?? "",
    action: formData.get("action") ?? "",
    narration: formData.get("narration") ?? "",
    dialogue: formData.get("dialogue") ?? "",
    durationSeconds: formData.get("durationSeconds") ?? "",
    visualPrompt: formData.get("visualPrompt") ?? "",
    negativePrompt: formData.get("negativePrompt") ?? "",
    notes: formData.get("notes") ?? "",
    characterIds: formData.getAll("characterIds"),
  });
}

export const characterInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  role: text(160),
  description: text(2000),
  visualDescription: z
    .string()
    .trim()
    .min(10, "Describe the look in enough detail to keep it consistent")
    .max(2000),
  notes: text(2000),
  status: z.enum(CHARACTER_STATUSES).default("draft"),
});

export type CharacterInput = z.infer<typeof characterInputSchema>;
export type CharacterFieldErrors = Partial<Record<keyof z.input<typeof characterInputSchema>, string[]>>;
export type CharacterFormState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: CharacterFieldErrors } | null;

export function parseCharacterForm(formData: FormData) {
  return characterInputSchema.safeParse({
    name: formData.get("name") ?? "",
    role: formData.get("role") ?? "",
    description: formData.get("description") ?? "",
    visualDescription: formData.get("visualDescription") ?? "",
    notes: formData.get("notes") ?? "",
    status: formData.get("status") ?? "draft",
  });
}

// ---------- Media ----------

export const MEDIA_TYPES: Record<string, { kind: AssetKind; ext: string }> = {
  "image/png": { kind: "image", ext: "png" },
  "image/jpeg": { kind: "image", ext: "jpg" },
  "image/webp": { kind: "image", ext: "webp" },
  "image/gif": { kind: "image", ext: "gif" },
  "video/mp4": { kind: "video", ext: "mp4" },
  "video/webm": { kind: "video", ext: "webm" },
  "video/quicktime": { kind: "video", ext: "mov" },
};

export const MAX_MEDIA_BYTES: Record<AssetKind, number> = {
  image: 30 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};

export function mediaUrl(filePath: string) {
  return `/media/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}
