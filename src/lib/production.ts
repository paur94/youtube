import { z } from "zod";

import { MAX_OVERLAYS, sceneOverlaySchema, validateOverlays } from "./overlays";
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
export const ASSET_SOURCES = ["higgsfield_api", "manual_import", "hedra_api", "replicate_api"] as const;
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
  hedra_api: "Hedra API",
  replicate_api: "Replicate API",
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

/** Whether voiced video models are asked for background music. */
export const CLIP_MUSIC_MODES = ["none", "music_mood"] as const;
export type ClipMusicMode = (typeof CLIP_MUSIC_MODES)[number];

export const CLIP_MUSIC_LABELS: Record<ClipMusicMode, string> = {
  none: "None (ambient sound only)",
  music_mood: "From music mood",
};

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
  "listener lip movement, silent character talking, two characters talking at once, wrong character speaking, slow drawn-out speech";

/**
 * Appended to the negative prompt of every video request. Over a long clip Wan drifts outfits back to
 * whatever the prompt describes elsewhere and adds people; Alibaba's Wan 3.0 prompt guide recommends
 * excluding costume changes explicitly.
 */
export const VIDEO_NEGATIVE_PROMPT =
  "costume change, outfit change, clothes changing colour, hairstyle change, character turning into someone else, extra people, subtitles, captions, jump cuts, narrator, voice-over";

const NARRATOR = "Narrator";

/** A timed beat of a scene's action: "3-7s: Levon lies back". */
export type ActionSegment = { start: number; end: number; text: string };

export type Timeline = {
  /** Lines before the first timed beat (camera, shot type). */
  preamble: string[];
  segments: ActionSegment[];
  /** Lines after the last timed beat (rules that apply to the whole clip). */
  notes: string[];
};

// A time stamp is seconds ("3", "3.5") or minutes:seconds ("0:03").
const STAMP = String.raw`(\d{1,3}(?::\d{2})?(?:\.\d+)?)`;
// "0-3s: text", "3 – 7 s: text", "[10-13s] text", "(0:00-0:03): text", "Shot 2 (3-7s): text".
const SEGMENT_RE = new RegExp(
  String.raw`^\s*(?:shot\s*\d+\s*[:：]?\s*)?([[(])?\s*${STAMP}\s*s?\s*(?:-|–|—|to)\s*${STAMP}\s*s?\s*([\])])?\s*([:：])?\s*(.*)$`,
  "i",
);

function stampSeconds(stamp: string) {
  const [first, second] = stamp.split(":");
  return second === undefined ? Number(first) : Number(first) * 60 + Number(second);
}

/**
 * Splits an action text into timed beats when it is written as a shot list ("0-3s: ...", one beat
 * per line); otherwise the segments are empty. Untimed lines before the beats are the preamble
 * (camera, framing) and lines after them are notes for the whole clip.
 */
export function parseTimeline(action: string): Timeline {
  const timeline: Timeline = { preamble: [], segments: [], notes: [] };
  for (const raw of action.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = SEGMENT_RE.exec(line);
    // A bare "2-3 children" is a count, not a beat: a beat is bracketed or followed by a colon.
    if (m && (m[1] || m[4] || m[5]) && m[6].trim()) {
      const start = stampSeconds(m[2]);
      const end = stampSeconds(m[3]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        timeline.segments.push({ start, end, text: m[6].trim() });
        continue;
      }
    }
    (timeline.segments.length ? timeline.notes : timeline.preamble).push(line);
  }
  return timeline;
}

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

/** True when every word of `needle` appears in `haystack` in order (punctuation and case ignored). */
function containsInOrder(haystack: string[], needle: string[]) {
  let i = 0;
  for (const word of haystack) if (word === needle[i]) i++;
  return i === needle.length;
}

/** True when `needle` appears in `haystack` as a contiguous run of words. */
function containsPhrase(haystack: string[], needle: string[]) {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let j = 0; j < needle.length; j++) if (haystack[start + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// Spans in straight or curly double quotes, or in single quotes that aren't apostrophes ("Yana's").
const QUOTED_RE = /["“”]([^"“”]+)["“”]|(?<![\p{L}\p{N}])['‘]([^'’‘]+)['’](?![\p{L}\p{N}])/gu;

function quotedSpans(text: string) {
  return [...text.matchAll(QUOTED_RE)].map((m) => words(m[1] ?? m[2] ?? ""));
}

/**
 * Finds the beat each spoken line belongs to, in order: a line is placed in the first beat (from the
 * previous line's beat onwards) that quotes it, so the clip's speech follows the choreography.
 * Exact quotes win over looser matches anywhere later, so a one-word line like "Up!" isn't caught
 * by an earlier beat that merely says "legs up". Lines the action doesn't quote get null and keep
 * their position in the list.
 */
export function placeLines(segments: ActionSegment[], lines: string[]) {
  const texts = segments.map((s) => words(s.text));
  const quotes = segments.map((s) => quotedSpans(s.text));
  const tiers: ((i: number, needle: string[]) => boolean)[] = [
    (i, needle) => quotes[i].some((q) => q.length === needle.length && containsPhrase(q, needle)),
    (i, needle) => containsPhrase(quotes[i].flat(), needle),
    (i, needle) => containsPhrase(texts[i], needle),
    (i, needle) => containsInOrder(texts[i], needle),
  ];
  let from = 0;
  return lines.map((line) => {
    const needle = words(line);
    if (!needle.length) return null;
    for (const matches of tiers) {
      for (let i = from; i < segments.length; i++) {
        if (matches(i, needle)) {
          from = i;
          return segments[i];
        }
      }
    }
    return null;
  });
}

function sentences(text: string) {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Turn = { speaker: string; line: string; at: { start: number; end: number } | null };

// A Dialogue row: "Name: line" or "Name: 0-3s: line" (also "0–3s", "0-3 s", "[0-3s]").
const DIALOGUE_ROW_RE = /^\s*([^:]+):\s*(?:\[?(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*s\]?\s*:?\s*)?(.+)$/;

/** Splits a dialogue row into speaker, optional timing and the spoken text, which never includes the timing. */
export function parseDialogueRow(row: string) {
  const m = DIALOGUE_ROW_RE.exec(row);
  if (!m) return null;
  const start = m[2] === undefined ? NaN : Number(m[2]);
  const end = m[3] === undefined ? NaN : Number(m[3]);
  return {
    speaker: m[1].trim(),
    line: m[4].trim(),
    timing: Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null,
  };
}

/** Rough length of a line spoken at a lively children's-TV pace. */
function speechSeconds(text: string) {
  return words(text).length / 2.5;
}

// A narrator cue in an action text: `Narrator: "..."`, `Voice-over says "..."`.
const NARRATOR_CUE_RE = /\s*\b(?:narrator|voice[- ]?over)\b(?:\s+says)?\s*[:：]?\s*(?:["“][^"”]*["”]|['‘][^'’]*['’])[.!]?/gi;

/** Removes narrator lines from action text: clips carry only the characters' own speech. */
export function stripNarration(text: string) {
  return text.replace(NARRATOR_CUE_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * The characters' spoken lines for video models that generate their own sound, in the syntax
 * Alibaba's Wan 3.0 prompt guide documents (`Name says: "line"`, "Lip sync"). There is no voice-over:
 * lines without a speaker are left out. Each line names who stays silent, because models tend to move
 * the listener's mouth too. A line written as "Name: 0-3s: line" is stamped [0-3s] outside the quotes;
 * otherwise, with a timed action (see parseTimeline), a line the action quotes is stamped with its
 * beat, so speech and movement line up and the lines aren't spread evenly over the clip. `onScreen` adds characters who are in the shot but have no lines.
 */
export function describeDialogue(
  lines: StoryScene["dialogue"],
  onScreen: string[] = [],
  options: { timeline?: ActionSegment[]; /** The prompt asks for music separately. */ music?: boolean } = {},
) {
  const spoken = lines
    .map((d) => parseDialogueRow(`${d.character.trim()}: ${d.line.trim()}`))
    .filter((d) => d !== null)
    .filter((d) => d.line && d.speaker && d.speaker.toLowerCase() !== NARRATOR.toLowerCase());
  if (!spoken.length) return "";
  const present = [...new Set([...onScreen.map((n) => n.trim()), ...spoken.map((d) => d.speaker)].filter(Boolean))];

  const segments = options.timeline ?? [];
  const placed = placeLines(
    segments,
    spoken.map((s) => s.line),
  );
  // A line's own timing wins over the beat that quotes it. Stable by start time; untimed lines keep
  // their list order at the end.
  const turns: Turn[] = spoken
    .map(({ speaker, line, timing }, index) => {
      const beat = placed[index];
      return { turn: { speaker, line, at: timing ?? (beat ? { start: beat.start, end: beat.end } : null) }, index };
    })
    .sort((a, b) => (a.turn.at?.start ?? Infinity) - (b.turn.at?.start ?? Infinity) || a.index - b.index)
    .map((t) => t.turn);
  const timed = turns.some((t) => t.at);

  const rendered = turns.map(({ speaker, line, at }) => {
    const stamp = at === null ? "" : `[${at.start}-${at.end}s] `;
    const listeners = present.filter((n) => n !== speaker);
    const silent = listeners.length
      ? listeners.length > 1
        ? ` ${joinNames(listeners)} keep their mouths closed.`
        : ` ${listeners[0]}'s mouth stays closed.`
      : "";
    return `${stamp}${speaker} says: "${line}" Lip sync.${silent}`;
  });

  const total = Math.round(turns.reduce((sum, t) => sum + speechSeconds(t.line), 0));
  const header =
    "Dialogue, spoken word for word" +
    (timed
      ? " at the second given, in step with the action above"
      : ", in this order, at the moment the action above says they speak") +
    `. Natural, lively children's-TV pace, about ${Math.max(total, 1)} seconds of speech in total: each line takes only as long as its words need and is never slowed or stretched; between lines nobody speaks. ` +
    "Only one character speaks at a time and only the speaker's lips move:";
  return `${header}\n${rendered.join("\n")}\nNo other dialogue. No narrator or voice-over.${options.music ? "" : " No background music."}`;
}

export type VideoPromptInput = {
  visualPrompt: string;
  action: string;
  dialogue: StoryScene["dialogue"];
  characters: PromptCharacter[];
  visualStyle?: string | null;
  /** Clip length that will be requested. */
  durationSeconds: number;
  /** The clip animates a start image, which already fixes the look, outfits, setting and framing. */
  startImage: boolean;
  /** The model generates its own sound, so the prompt carries the dialogue. */
  voiced: boolean;
  /** Music mood to ask a voiced model for (see clipMusicMood); without one the clip has no music. */
  music?: string | null;
};

/** The identifying first sentence of a character's bible entry, unless it already names clothes. */
function identity(character: PromptCharacter) {
  const first = sentences(character.visualDescription)[0] ?? "";
  return first && !/\b(wear|wears|wearing|dressed|outfit|clothes)\b/i.test(first) ? first.replace(/[.!?]$/, "") : "";
}

/**
 * The prompt for a video model, following Alibaba's Wan 3.0 prompt guide: an overall line, the
 * scene's action as timed shots, then the dialogue. Clips never get a voice-over: the scene's
 * narration isn't sent and narrator cues are removed from the action. The scene's visual prompt
 * describes the keyframe (a still pose), so with a start image it is left out and the image is declared the lock for
 * characters, outfits and setting; the character bible is left out too, because its canonical outfit
 * contradicts a scene that dresses a character differently and the model follows the text over the
 * image. Text-to-video has no image to lock to, so it keeps the visual prompt and the bible.
 */
export function buildVideoPrompt(input: VideoPromptInput) {
  const style = input.visualStyle?.trim();
  const names = input.characters.map((c) => c.name.trim()).filter(Boolean);
  const action = stripNarration(input.action);
  const timeline = parseTimeline(action);
  const parts: string[] = [];

  if (input.startImage) {
    parts.push(
      `${style ? `${style}. ` : ""}A ${input.durationSeconds}-second clip that continues from the first-frame image: ` +
        "keep the characters, their clothes, the room, the camera angle and the art style exactly as in that image from the first second to the last.",
    );
    if (names.length) {
      const who = input.characters
        .map((c) => {
          const id = identity(c);
          return id ? `${c.name.trim()} (${id.charAt(0).toLowerCase()}${id.slice(1)})` : c.name.trim();
        })
        .join("; ");
      parts.push(
        `Characters, exactly as in the first frame: ${who}. Same face, hair, proportions and outfit throughout; ` +
          `no costume changes. Only ${names.length > 1 ? "these characters" : "this character"} appear; no one else enters.`,
      );
    }
  } else {
    parts.push(buildGenerationPrompt({ visualPrompt: input.visualPrompt, characters: input.characters, visualStyle: style }));
    parts.push(`A ${input.durationSeconds}-second clip. Outfits, faces and setting stay exactly the same from start to end.`);
  }

  if (timeline.segments.length) {
    parts.push(
      [
        ...timeline.preamble,
        ...timeline.segments.map((s, i) => `Shot ${i + 1} [${s.start}-${s.end}s]: ${s.text}`),
        ...timeline.notes,
      ].join("\n"),
    );
  } else if (action) {
    parts.push(`Action: ${action}`);
  } else if (input.startImage && input.visualPrompt.trim()) {
    // Older scenes keep the motion in the visual prompt.
    parts.push(input.visualPrompt.trim());
  }

  if (input.voiced) {
    const music = input.music?.replace(/\s+/g, " ").replace(/[\s.,;:!]+$/, "").trim();
    const dialogue = describeDialogue(input.dialogue, names, { timeline: timeline.segments, music: Boolean(music) });
    if (!music) {
      parts.push(dialogue || "No dialogue, no narrator or voice-over. Quiet ambient sound only; no background music.");
    } else if (dialogue) {
      // "No voices" would contradict the lines above.
      parts.push(dialogue, `Audio: ${music}, soft and quiet under the dialogue and ambient sounds. No other voices, no singing.`);
    } else {
      parts.push("No dialogue, no narrator or voice-over.", `Audio: ${music}, soft and quiet under ambient sounds. No voices, no singing.`);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The music mood a scene's clip asks for when the plan's "Music in generated clips" setting uses it:
 * the story scene's own mood (matched by title, then by number), else the story's overall mood.
 */
export function clipMusicMood(
  mode: string,
  content: Pick<StoryContent, "scenes" | "musicMood"> | null,
  scene: { position: number; title: string },
) {
  if (mode !== "music_mood" || !content) return null;
  const title = scene.title.trim().toLowerCase();
  const match =
    content.scenes.find((s) => s.title.trim().toLowerCase() === title) ??
    content.scenes.find((s) => Number(s.number) === scene.position + 1);
  return match?.musicMood?.trim() || content.musicMood?.trim() || null;
}

function joinNames(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/**
 * Tells a reference-image model which attached image shows which characters, in upload order.
 * One image can show several characters (e.g. an approved group keyframe). `sceneImages` follow
 * the character images: extra scene references (props, places, an approved keyframe).
 */
export function describeReferenceImages(images: string[][], sceneImages = 0) {
  if (!images.length && !sceneImages) return "";
  const parts: string[] = [];
  if (images.length) {
    const list = images.map((names, i) => `image ${i + 1} shows ${joinNames(names)}`).join("; ");
    parts.push(
      `The attached reference images show the characters: ${list}. ` +
        "Keep each character's face, hair, proportions, colours and outfit exactly as in their reference image, " +
        "and place them in the new scene described above.",
    );
  }
  if (sceneImages) {
    const first = images.length + 1;
    const range = sceneImages === 1 ? `Image ${first} shows` : `Images ${first} to ${first + sceneImages - 1} show`;
    parts.push(`${range} the setting, props and objects of this scene: keep their shapes, colours and number exactly the same.`);
  }
  return parts.join(" ");
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
  notes: string;
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
      notes: scene.productionNotes ?? "",
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

export const sceneInputSchema = z
  .object({
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
    overlays: z.array(sceneOverlaySchema, "Invalid overlays").max(MAX_OVERLAYS * 2).default([]),
    characterIds: z.array(z.uuid()).max(30).default([]),
  })
  .superRefine((scene, ctx) => {
    for (const message of validateOverlays(scene.overlays, scene.durationSeconds)) {
      ctx.addIssue({ code: "custom", path: ["overlays"], message });
    }
  });

export type SceneInput = z.infer<typeof sceneInputSchema>;
export type SceneFieldErrors = Partial<Record<keyof z.input<typeof sceneInputSchema>, string[]>>;
export type SceneFormState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: SceneFieldErrors } | null;

function parseJson(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

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
    overlays: parseJson(formData.get("overlays")),
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
