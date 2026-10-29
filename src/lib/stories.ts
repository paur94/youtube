import { z } from "zod";

import { AGE_GROUPS } from "./ideas";

// Shared by the DB schema, server actions, the Claude prompt and client forms.
export const STORY_STATUSES = ["draft", "review", "approved"] as const;
export const REVISION_SOURCES = ["generated", "regenerated", "edited", "restored"] as const;

export type StoryStatus = (typeof STORY_STATUSES)[number];
export type RevisionSource = (typeof REVISION_SOURCES)[number];

export const STORY_STATUS_LABELS: Record<StoryStatus, string> = {
  draft: "Brief only",
  review: "In review",
  approved: "Approved for production",
};

export const REVISION_SOURCE_LABELS: Record<RevisionSource, string> = {
  generated: "Generated",
  regenerated: "Regenerated",
  edited: "Edited",
  restored: "Restored",
};

export const DURATION_PRESETS = [45, 60, 120, 180, 300, 480, 600, 900] as const;

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m} min`;
}

export const TONE_SUGGESTIONS = [
  "Warm and gentle",
  "Playful and silly",
  "Calm bedtime",
  "Curious and adventurous",
  "Upbeat and energetic",
];

export const VISUAL_STYLE_SUGGESTIONS = [
  "Soft 3D animation, pastel colours",
  "Hand-drawn watercolour storybook",
  "Bright flat 2D cartoon",
  "Paper cut-out collage",
  "Claymation look",
];

export const LANGUAGE_SUGGESTIONS = ["English", "Spanish", "French", "German", "Portuguese", "Armenian", "Russian"];

// ---------- Story brief (user input) ----------

export const storyInputSchema = z.object({
  ideaId: z
    .string()
    .trim()
    .default("")
    .refine((s) => s === "" || z.uuid().safeParse(s).success, "Invalid idea")
    .transform((s) => s || null),
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
  ageGroup: z.enum(AGE_GROUPS, "Choose an age range"),
  topic: z.string().trim().min(3, "Describe the topic in a few words").max(300),
  learningObjective: z
    .string()
    .trim()
    .min(3, "Add a learning objective, e.g. “count to five”")
    .max(500),
  characters: z.string().trim().max(2000).default(""),
  targetDurationSeconds: z.coerce
    .number("Choose a duration")
    .int()
    .refine((n) => (DURATION_PRESETS as readonly number[]).includes(n), "Choose a duration"),
  tone: z.string().trim().min(2, "Describe the tone").max(80),
  visualStyle: z.string().trim().min(2, "Describe the visual style").max(160),
  language: z.string().trim().min(2, "Enter a language").max(40),
  notes: z.string().trim().max(2000).default(""),
});

export type StoryInput = z.infer<typeof storyInputSchema>;
export type StoryFieldErrors = Partial<Record<keyof z.input<typeof storyInputSchema>, string[]>>;

export type StoryFormState =
  { ok: true; message: string } | { ok: false; message?: string; errors?: StoryFieldErrors } | null;

export function parseStoryForm(formData: FormData) {
  return storyInputSchema.safeParse({
    ideaId: formData.get("ideaId") ?? "",
    title: formData.get("title") ?? "",
    ageGroup: formData.get("ageGroup"),
    topic: formData.get("topic") ?? "",
    learningObjective: formData.get("learningObjective") ?? "",
    characters: formData.get("characters") ?? "",
    targetDurationSeconds: formData.get("targetDurationSeconds") ?? "",
    tone: formData.get("tone") ?? "",
    visualStyle: formData.get("visualStyle") ?? "",
    language: formData.get("language") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

// ---------- Generated story (Claude structured output, also used to validate edits) ----------

export const REVIEW_CHECKS = [
  "age_appropriate_language",
  "no_frightening_content",
  "no_unsafe_imitable_behavior",
  "positive_messages",
  "learning_objective_addressed",
  "original_characters",
  "original_plot",
  "no_brands_or_real_people",
  "inclusive_and_respectful",
] as const;

export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

export const REVIEW_CHECK_LABELS: Record<ReviewCheck, string> = {
  age_appropriate_language: "Vocabulary and sentence length suit the age range",
  no_frightening_content: "Nothing frightening, violent or upsetting for this age",
  no_unsafe_imitable_behavior: "No unsafe behaviour children might copy",
  positive_messages: "Positive, kind social messages",
  learning_objective_addressed: "Learning objective is clearly addressed",
  original_characters: "Characters are original (no existing shows or franchises)",
  original_plot: "Plot is original, not a retelling of a known story",
  no_brands_or_real_people: "No brands, products or real people",
  inclusive_and_respectful: "Inclusive and respectful; no stereotypes",
};

// Number constraints (.int(), .min()) are deliberately left out: structured outputs only support a
// subset of JSON Schema, and the SDK moves unsupported keywords into descriptions.
const dialogueLineSchema = z.object({ character: z.string(), line: z.string() });

const sceneSchema = z.object({
  number: z.number(),
  title: z.string(),
  durationSeconds: z.number(),
  setting: z.string(),
  action: z.string(),
  narration: z.string(),
  characters: z.array(z.string()),
  dialogue: z.array(dialogueLineSchema),
  visualPrompt: z.string(),
  soundEffects: z.array(z.string()),
  musicMood: z.string(),
});

export const storyContentSchema = z.object({
  title: z.string(),
  premise: z.string(),
  learningOutcome: z.string(),
  beginning: z.string(),
  middle: z.string(),
  ending: z.string(),
  narration: z.string(),
  characters: z.array(
    z.object({ name: z.string(), role: z.string(), description: z.string(), visualDescription: z.string() }),
  ),
  scenes: z.array(sceneSchema),
  musicMood: z.string(),
  estimatedDurationSeconds: z.number(),
  reviewChecklist: z.array(
    z.object({ check: z.enum(REVIEW_CHECKS), status: z.enum(["pass", "concern"]), note: z.string() }),
  ),
});

export type StoryContent = z.infer<typeof storyContentSchema>;
export type StoryScene = StoryContent["scenes"][number];

// Edits are posted as JSON; cap the size so a runaway payload can't bloat the revision table.
export const MAX_CONTENT_BYTES = 300_000;

export function parseStoryContentJson(json: string) {
  if (new TextEncoder().encode(json).length > MAX_CONTENT_BYTES) {
    return { success: false as const, message: "The story is too large to save" };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { success: false as const, message: "Could not read the edited story" };
  }
  const parsed = storyContentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      success: false as const,
      message: `Invalid story content at ${issue.path.join(".") || "root"}: ${issue.message}`,
    };
  }
  if (!parsed.data.title.trim()) return { success: false as const, message: "The story needs a title" };
  return { success: true as const, data: parsed.data };
}

export function sumSceneDurations(content: Pick<StoryContent, "scenes">) {
  return content.scenes.reduce((total, scene) => total + (Number(scene.durationSeconds) || 0), 0);
}

// The editor shows dialogue as "Name: line" rows, one per line.
export function formatDialogue(lines: StoryScene["dialogue"]) {
  return lines.map((d) => `${d.character}: ${d.line}`).join("\n");
}

export function parseDialogue(text: string): StoryScene["dialogue"] {
  return text
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const at = row.indexOf(":");
      if (at <= 0) return { character: "Narrator", line: row };
      return { character: row.slice(0, at).trim(), line: row.slice(at + 1).trim() };
    });
}

export function parseList(text: string) {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
