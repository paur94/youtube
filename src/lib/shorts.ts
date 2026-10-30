import { z } from "zod";

import { findPromptConcerns } from "./production";
import type { StoryScene } from "./stories";

// Shared by the DB schema, server actions, the Claude prompt and client components.
export const SHORT_STATUSES = ["draft", "approved", "rejected", "scheduled", "published"] as const;
export type ShortStatus = (typeof SHORT_STATUSES)[number];

export const SHORT_STATUS_LABELS: Record<ShortStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  scheduled: "Scheduled",
  published: "Published",
};

/** A scheduled Short whose planned time has passed without being marked published. */
export function isOverdue(status: ShortStatus, scheduledAt: Date | null, now = Date.now()) {
  return status === "scheduled" && scheduledAt !== null && scheduledAt.getTime() < now;
}

/** Statuses that appear in the publishing queue. */
export const QUEUE_STATUSES: readonly ShortStatus[] = ["approved", "scheduled", "published"];

/** YouTube limits (Data API `videos` resource). */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_MAX_CHARS = 500;
/** YouTube ignores every hashtag on a video that has more than this many. */
export const HASHTAGS_IGNORED_ABOVE = 60;
export const HASHTAGS_RECOMMENDED_MAX = 15;

/** A YouTube Short may be up to 3 minutes long. */
export const SHORT_MAX_SECONDS = 180;
export const SHORT_COMFORT_SECONDS = 60;

// ---------- Video settings ----------

export const videoSettingsSchema = z.object({
  /** 1 = whole source frame visible (letterboxed on a blurred background); higher crops in. */
  zoom: z.coerce.number().min(1).max(4),
  /** Horizontal / vertical focus point (0-100 %) used when zooming crops the frame. */
  focusX: z.coerce.number().min(0).max(100),
  focusY: z.coerce.number().min(0).max(100),
  burnCaptions: z.boolean(),
  showHook: z.boolean(),
  normalizeAudio: z.boolean(),
});

export type VideoSettings = z.infer<typeof videoSettingsSchema>;

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  zoom: 1,
  focusX: 50,
  focusY: 50,
  burnCaptions: true,
  showHook: true,
  normalizeAudio: true,
};

export function parseVideoSettingsForm(formData: FormData) {
  return videoSettingsSchema.safeParse({
    zoom: formData.get("zoom") ?? 1,
    focusX: formData.get("focusX") ?? 50,
    focusY: formData.get("focusY") ?? 50,
    burnCaptions: formData.get("burnCaptions") === "on",
    showHook: formData.get("showHook") === "on",
    normalizeAudio: formData.get("normalizeAudio") === "on",
  });
}

/** Everything that changes the rendered file; a render is stale when its key differs. */
export function renderKey(input: {
  sourceFilePath: string | null;
  settings: VideoSettings;
  captions: CaptionCue[];
  hook: string;
  hookSeconds: number;
}) {
  const s = input.settings;
  return JSON.stringify({
    source: input.sourceFilePath,
    zoom: s.zoom,
    focusX: s.focusX,
    focusY: s.focusY,
    normalizeAudio: s.normalizeAudio,
    captions: s.burnCaptions ? input.captions : null,
    hook: s.showHook && input.hook.trim() ? [input.hook.trim(), input.hookSeconds] : null,
  });
}

// ---------- Captions ----------

export type CaptionCue = { start: number; end: number; text: string };

const MAX_CUE_CHARS = 42;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Splits a line into caption-sized chunks on word boundaries. */
export function chunkLine(line: string, maxChars = MAX_CUE_CHARS) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && `${current} ${word}`.length > maxChars) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * First-draft captions from the scene's dialogue, spread over the clip in proportion to word
 * count. The timing is an estimate: the generated audio isn't transcribed, so it must be checked
 * against the video before the captions are marked reviewed.
 */
export function buildCaptionsFromDialogue(
  lines: StoryScene["dialogue"],
  durationSeconds: number,
  options: { lead?: number; tail?: number } = {},
): CaptionCue[] {
  const lead = options.lead ?? 0.4;
  const tail = options.tail ?? 0.4;
  const chunks = lines.flatMap((d, lineIndex) =>
    chunkLine(d.line).map((text, i, all) => ({ text, words: text.split(/\s+/).length, gapAfter: i === all.length - 1, lineIndex })),
  );
  if (!chunks.length || durationSeconds <= lead + tail) return [];

  // A pause between speakers counts as roughly half a word.
  const PAUSE = 0.5;
  const weight = chunks.reduce((sum, c) => sum + c.words + (c.gapAfter ? PAUSE : 0), 0);
  const perUnit = (durationSeconds - lead - tail) / weight;
  let t = lead;
  return chunks.map((c) => {
    const start = round1(t);
    t += c.words * perUnit;
    const end = round1(t);
    if (c.gapAfter) t += PAUSE * perUnit;
    return { start, end: Math.max(end, round1(start + 0.1)), text: c.text };
  });
}

function formatSeconds(n: number) {
  return Number.isInteger(n) ? n.toFixed(1) : String(round1(n));
}

/** Editor format: one cue per line, `start-end | text` in seconds. */
export function formatCaptionLines(cues: CaptionCue[]) {
  return cues.map((c) => `${formatSeconds(c.start)}-${formatSeconds(c.end)} | ${c.text}`).join("\n");
}

function parseTime(value: string) {
  const parts = value.trim().split(":");
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

export function parseCaptionLines(text: string): { cues: CaptionCue[]; errors: string[] } {
  const cues: CaptionCue[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((raw, i) => {
    const row = raw.trim();
    if (!row) return;
    const match = /^([\d:.]+)\s*-\s*([\d:.]+)\s*\|\s*(.+)$/.exec(row);
    if (!match) {
      errors.push(`Line ${i + 1}: use “start-end | text”, e.g. 0.5-2.8 | Hello!`);
      return;
    }
    const start = parseTime(match[1]);
    const end = parseTime(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      errors.push(`Line ${i + 1}: times must be seconds like 1.5 or 0:01.5`);
      return;
    }
    if (end <= start) {
      errors.push(`Line ${i + 1}: the end time must be after the start time`);
      return;
    }
    cues.push({ start: round1(start), end: round1(end), text: match[3].trim().slice(0, 200) });
  });
  cues.sort((a, b) => a.start - b.start);
  return { cues, errors };
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** SubRip file for uploading as a YouTube caption track. */
export function toSrt(cues: CaptionCue[]) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

export type Issue = { level: "warn" | "fail"; message: string };

/** Readable-speed limit for young viewers (and the parents reading along). */
export const MAX_CHARS_PER_SECOND = 15;

export function validateCaptions(cues: CaptionCue[], durationSeconds: number | null): Issue[] {
  const issues: Issue[] = [];
  cues.forEach((c, i) => {
    const n = i + 1;
    if (durationSeconds !== null && c.end > durationSeconds + 0.05) {
      issues.push({ level: "fail", message: `Caption ${n} ends at ${c.end}s, after the video ends (${round1(durationSeconds)}s)` });
    }
    const next = cues[i + 1];
    if (next && next.start < c.end - 0.05) {
      issues.push({ level: "fail", message: `Captions ${n} and ${n + 1} overlap` });
    }
    const length = c.end - c.start;
    if (length < 0.7) issues.push({ level: "warn", message: `Caption ${n} is on screen for only ${round1(length)}s` });
    else if (c.text.length / length > MAX_CHARS_PER_SECOND) {
      issues.push({ level: "warn", message: `Caption ${n} is too fast to read (${Math.round(c.text.length / length)} characters/s)` });
    }
  });
  return issues;
}

// ---------- Metadata ----------

/** Normalises user or Claude hashtags: one word each, `#` prefix, no duplicates. */
export function normalizeHashtags(input: string | string[]) {
  const raw = Array.isArray(input) ? input : input.split(/[\s,]+/);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const word = item.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!word || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    tags.push(`#${word}`);
  }
  return tags;
}

const text = (max: number) => z.string().trim().max(max).default("");

export const shortMetadataSchema = z.object({
  title: z.string().trim().min(1, "Give the Short a title").max(TITLE_MAX, `YouTube titles are limited to ${TITLE_MAX} characters`),
  description: text(DESCRIPTION_MAX),
  hashtags: z.string().default("").transform(normalizeHashtags),
  playlist: text(150),
  hook: text(120),
  hookSeconds: z.coerce.number("Enter seconds").min(0.5, "At least 0.5 s").max(10, "At most 10 s"),
  publishOrder: z
    .string()
    .trim()
    .default("")
    .transform((s) => (s === "" ? null : Number(s)))
    .refine((n) => n === null || (Number.isInteger(n) && n >= 1 && n <= 999), "Use a whole number from 1"),
  notes: text(4000),
});

export type ShortMetadataInput = z.infer<typeof shortMetadataSchema>;
export type ShortMetadataErrors = Partial<Record<keyof z.input<typeof shortMetadataSchema>, string[]>>;
export type ShortMetadataState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: ShortMetadataErrors } | null;

export function parseShortMetadataForm(formData: FormData) {
  return shortMetadataSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    hashtags: formData.get("hashtags") ?? "",
    playlist: formData.get("playlist") ?? "",
    hook: formData.get("hook") ?? "",
    hookSeconds: formData.get("hookSeconds") ?? "",
    publishOrder: formData.get("publishOrder") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

// Made-for-kids content may not ask viewers to engage or buy (COPPA / YouTube Kids policies).
const CALL_TO_ACTION = /\b(subscribe|like (this|the) video|smash (that|the) like|hit the bell|comment below|leave a comment|link in (the )?(bio|description)|buy now|shop now)\b/i;

/** Hard problems in the metadata that block approval. */
export function findMetadataConcerns(meta: { title: string; description: string; hashtags: string[]; hook: string }) {
  const all = [meta.title, meta.description, meta.hashtags.join(" "), meta.hook].join("\n");
  const concerns = findPromptConcerns(all.replace(/#/g, " "));
  if (CALL_TO_ACTION.test(all)) {
    concerns.push("Asks viewers to subscribe, like, comment or buy. Not allowed in made-for-kids content");
  }
  return concerns;
}

// ---------- YouTube upload metadata ----------

const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  portuguese: "pt",
  armenian: "hy",
  russian: "ru",
  italian: "it",
};

/** "Film & Animation". Change in YouTube Studio if "Education" (27) fits better. */
export const DEFAULT_CATEGORY_ID = "1";

export function buildDescription(description: string, hashtags: string[]) {
  const body = description.trim();
  const tags = hashtags.join(" ");
  return [body, tags].filter(Boolean).join("\n\n");
}

/**
 * Body for the YouTube Data API `videos.insert` call (snippet + status), plus the extras that
 * are separate calls (playlist, caption track). Nothing is uploaded by this app yet: use it to fill
 * in YouTube Studio by hand, or for a later upload integration.
 */
export function buildYouTubeMetadata(input: {
  title: string;
  description: string;
  hashtags: string[];
  playlist: string;
  language: string | null;
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  scheduledAt: Date | null;
  hasCaptions: boolean;
}) {
  const language = input.language ? LANGUAGE_CODES[input.language.trim().toLowerCase()] : undefined;
  const tags: string[] = [];
  let tagChars = 0;
  for (const tag of input.hashtags.map((h) => h.replace(/^#/, ""))) {
    // YouTube counts the comma separators toward the 500-character limit.
    if (tagChars + tag.length + (tags.length ? 1 : 0) > TAGS_MAX_CHARS) break;
    tagChars += tag.length + (tags.length ? 1 : 0);
    tags.push(tag);
  }
  const future = input.scheduledAt && input.scheduledAt.getTime() > Date.now() ? input.scheduledAt : null;
  return {
    snippet: {
      title: input.title.trim().slice(0, TITLE_MAX),
      description: buildDescription(input.description, input.hashtags).slice(0, DESCRIPTION_MAX),
      tags,
      categoryId: DEFAULT_CATEGORY_ID,
      ...(language ? { defaultLanguage: language, defaultAudioLanguage: language } : {}),
    },
    status: {
      // Scheduled uploads must be private with a publishAt time; YouTube makes them public then.
      privacyStatus: "private" as const,
      ...(future ? { publishAt: future.toISOString() } : {}),
      selfDeclaredMadeForKids: input.madeForKids,
      containsSyntheticMedia: input.containsSyntheticMedia,
      license: "youtube" as const,
      embeddable: true,
    },
    extras: {
      playlist: input.playlist.trim() || null,
      captionsFile: input.hasCaptions ? "captions.srt" : null,
      orientation: "vertical 9:16 (1080×1920)",
    },
  };
}

// ---------- Claude analysis ----------

// Number constraints are left out on purpose (structured outputs support a subset of JSON Schema).
export const shortAnalysisSchema = z.object({
  standalone: z.object({
    verdict: z.enum(["strong", "usable", "weak"]),
    reasons: z.array(z.string()),
  }),
  structure: z.object({
    beginning: z.string(),
    middle: z.string(),
    ending: z.string(),
    clearArc: z.boolean(),
    note: z.string(),
  }),
  opening: z.object({ strength: z.enum(["strong", "ok", "weak"]), note: z.string() }),
  hook: z.object({ onScreenText: z.string(), rationale: z.string() }),
  narrationSuggestions: z.array(z.object({ issue: z.string(), suggestion: z.string() })),
  music: z.object({ mood: z.string(), description: z.string() }),
  soundEffects: z.array(z.object({ moment: z.string(), effect: z.string() })),
  metadata: z.object({
    title: z.string(),
    description: z.string(),
    hashtags: z.array(z.string()),
    playlist: z.string(),
  }),
  childSafety: z.object({ status: z.enum(["pass", "concern"]), notes: z.string() }),
});

export type ShortAnalysis = z.infer<typeof shortAnalysisSchema>;

export const STANDALONE_LABELS: Record<ShortAnalysis["standalone"]["verdict"], string> = {
  strong: "Strong standalone",
  usable: "Works standalone",
  weak: "Weak standalone",
};

export const publishOrderSchema = z.object({
  order: z.array(z.object({ shortNumber: z.number(), reason: z.string() })),
  note: z.string(),
});

export type PublishOrderSuggestion = z.infer<typeof publishOrderSchema>;

/**
 * Maps Claude's 1-based order onto short ids. Unknown or repeated numbers are ignored and shorts
 * Claude left out go last in their current order, so the result is always a full permutation.
 */
export function applyPublishOrder(ids: string[], suggestion: PublishOrderSuggestion) {
  const used = new Set<number>();
  const ordered: { id: string; reason: string }[] = [];
  for (const item of suggestion.order) {
    const index = Math.round(item.shortNumber) - 1;
    if (index < 0 || index >= ids.length || used.has(index)) continue;
    used.add(index);
    ordered.push({ id: ids[index], reason: item.reason });
  }
  ids.forEach((id, index) => {
    if (!used.has(index)) ordered.push({ id, reason: "Not ranked by Claude; kept in scene order." });
  });
  return ordered.map((o, i) => ({ ...o, position: i + 1 }));
}

// ---------- Analytics ----------

export type MetricKey =
  | "views"
  | "averageViewDurationSeconds"
  | "viewedPercent"
  | "averagePercentageViewed"
  | "likes"
  | "subscribersGained"
  | "trafficSources";

export type MetricDefinition = {
  key: MetricKey;
  label: string;
  /** Where YouTube reports it. */
  studio: string;
  /** YouTube Analytics API metric or dimension, or null when the API doesn't expose it. */
  api: string | null;
};

// Availability as documented when this milestone was built; check YouTube's docs before relying on it.
export const SHORT_METRICS: MetricDefinition[] = [
  { key: "views", label: "Views", studio: "Studio → Content → Shorts → Analytics → Overview", api: "views" },
  {
    key: "averageViewDurationSeconds",
    label: "Average view duration",
    studio: "Analytics → Engagement",
    api: "averageViewDuration",
  },
  {
    key: "viewedPercent",
    label: "Viewed vs swiped away",
    studio: "Analytics → Engagement (Shorts only)",
    api: null,
  },
  {
    key: "averagePercentageViewed",
    label: "Audience retention (avg % viewed)",
    studio: "Analytics → Engagement → Audience retention",
    api: "averageViewPercentage (curve: audienceWatchRatio)",
  },
  { key: "likes", label: "Likes", studio: "Analytics → Engagement", api: "likes" },
  { key: "subscribersGained", label: "Subscribers gained", studio: "Analytics → Audience", api: "subscribersGained" },
  {
    key: "trafficSources",
    label: "Traffic sources",
    studio: "Analytics → Reach → Traffic source types",
    api: "insightTrafficSourceType (dimension)",
  },
];

export const TRAFFIC_SOURCES = ["shorts_feed", "browse", "search", "channel", "external", "other"] as const;
export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

export const TRAFFIC_SOURCE_LABELS: Record<TrafficSource, string> = {
  shorts_feed: "Shorts feed",
  browse: "Browse features",
  search: "YouTube search",
  channel: "Channel pages",
  external: "External",
  other: "Other",
};

const optionalNumber = (max: number, integer = false) =>
  z
    .string()
    .trim()
    .default("")
    .transform((s) => (s === "" ? null : Number(s.replace(/,/g, ""))))
    .refine((n) => n === null || (Number.isFinite(n) && n >= 0 && n <= max && (!integer || Number.isInteger(n))), {
      message: integer ? "Enter a whole number" : "Enter a number",
    });

export const metricsInputSchema = z.object({
  capturedAt: z.coerce.date("Enter the date the numbers are from"),
  views: optionalNumber(1e12, true),
  averageViewDurationSeconds: optionalNumber(3600),
  viewedPercent: optionalNumber(100),
  averagePercentageViewed: optionalNumber(1000),
  likes: optionalNumber(1e12, true),
  subscribersGained: optionalNumber(1e9, true),
  traffic_shorts_feed: optionalNumber(100),
  traffic_browse: optionalNumber(100),
  traffic_search: optionalNumber(100),
  traffic_channel: optionalNumber(100),
  traffic_external: optionalNumber(100),
  traffic_other: optionalNumber(100),
  notes: text(2000),
});

export function parseMetricsForm(formData: FormData) {
  const parsed = metricsInputSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return parsed;
  const trafficSources: Partial<Record<TrafficSource, number>> = {};
  for (const s of TRAFFIC_SOURCES) {
    const value = parsed.data[`traffic_${s}`];
    if (value !== null) trafficSources[s] = value;
  }
  return {
    success: true as const,
    data: {
      capturedAt: parsed.data.capturedAt,
      views: parsed.data.views,
      averageViewDurationSeconds: parsed.data.averageViewDurationSeconds,
      viewedPercent: parsed.data.viewedPercent,
      averagePercentageViewed: parsed.data.averagePercentageViewed,
      likes: parsed.data.likes,
      subscribersGained: parsed.data.subscribersGained,
      trafficSources: Object.keys(trafficSources).length ? trafficSources : null,
      notes: parsed.data.notes,
    },
  };
}

export type MetricState = "value" | "not_entered" | "not_published";

/** Why a metric cell is empty: never pretend a missing number is zero. */
export function metricState(published: boolean, value: unknown): MetricState {
  if (!published) return "not_published";
  if (value === null || value === undefined) return "not_entered";
  return "value";
}
