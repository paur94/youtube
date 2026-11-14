import { z } from "zod";

// Adult Lab: a single-page test bench for stories aimed at grown-up audiences. Topic and reference images go
// in, GPT (OpenAI) writes an editable story split into clips, and each clip gets a Grok Image 2.0 keyframe and a
// Kling 4.0 clip. It skips the kids pipeline (QC, characters, production plans) on purpose.

export const LAB_IMAGE_MODEL = "grok-image-2";
/** Kling 4.0 variants on Replicate: start frame, reference images, or prompt only. */
export const LAB_VIDEO_MODELS = {
  startImage: "replicate-kling-4-i2v",
  references: "replicate-kling-4-r2v",
  text: "replicate-kling-4-t2v",
} as const;

export const LAB_ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export type LabAspectRatio = (typeof LAB_ASPECT_RATIOS)[number];

export const LAB_MAX_REFERENCES = 8;
export const LAB_TOPIC_MAX = 4000;
/** Kling 4.0 takes 3–30 seconds. */
export const LAB_MIN_SECONDS = 3;
export const LAB_MAX_SECONDS = 30;

export type LabReference = { id: string; filePath: string; contentType: string; name: string };

/** What GPT returns; ids are added afterwards. */
export const labStoryOutputSchema = z.object({
  title: z.string(),
  logline: z.string(),
  characters: z.array(z.object({ name: z.string(), look: z.string() })),
  scenes: z.array(
    z.object({
      title: z.string(),
      imagePrompt: z.string(),
      videoPrompt: z.string(),
      dialogue: z.string(),
      durationSeconds: z.number(),
    }),
  ),
});
export type LabStoryOutput = z.infer<typeof labStoryOutputSchema>;

export const labSceneSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(200),
  imagePrompt: z.string().max(4000),
  videoPrompt: z.string().max(4000),
  dialogue: z.string().max(4000),
  durationSeconds: z.number().int().min(LAB_MIN_SECONDS).max(LAB_MAX_SECONDS),
  /** Generated image used as the clip's first frame; null sends the reference images instead. */
  startImageJobId: z.string().nullable(),
});
export type LabScene = z.infer<typeof labSceneSchema>;

export const labStorySchema = z.object({
  title: z.string().max(300),
  logline: z.string().max(2000),
  characters: z.array(z.object({ name: z.string().max(200), look: z.string().max(2000) })).max(20),
  scenes: z.array(labSceneSchema).min(1).max(30),
});
export type LabStory = z.infer<typeof labStorySchema>;

export function clampSeconds(value: number) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(LAB_MAX_SECONDS, Math.max(LAB_MIN_SECONDS, Math.round(value)));
}

export function newSceneId() {
  return Math.random().toString(36).slice(2, 10);
}

export function storyFromOutput(output: LabStoryOutput): LabStory {
  return {
    title: output.title.trim(),
    logline: output.logline.trim(),
    characters: output.characters.map((c) => ({ name: c.name.trim(), look: c.look.trim() })),
    scenes: output.scenes.slice(0, 30).map((s) => ({
      id: newSceneId(),
      title: s.title.trim(),
      imagePrompt: s.imagePrompt.trim(),
      videoPrompt: s.videoPrompt.trim(),
      dialogue: s.dialogue.trim(),
      durationSeconds: clampSeconds(s.durationSeconds),
      startImageJobId: null,
    })),
  };
}

function characterSheet(story: Pick<LabStory, "characters">) {
  return story.characters
    .filter((c) => c.name && c.look)
    .map((c) => `${c.name}: ${c.look}`)
    .join("\n");
}

/** Prompt for the scene's Grok keyframe: the frame itself plus the cast's looks for consistency. */
export function buildLabImagePrompt(story: LabStory, scene: LabScene, referenceCount: number) {
  const parts = [scene.imagePrompt.trim()];
  const sheet = characterSheet(story);
  if (sheet) parts.push(`Characters (keep exactly this look):\n${sheet}`);
  if (referenceCount) {
    parts.push(
      `The ${referenceCount === 1 ? "attached image is a reference" : `${referenceCount} attached images are references`} for the characters, setting and style; match them closely.`,
    );
  }
  return parts.join("\n\n");
}

export type LabVideoMode = keyof typeof LAB_VIDEO_MODELS;

/**
 * Prompt for the scene's Kling clip. Only the characters' own spoken lines go in: no narrator or voice-over.
 * Kling numbers attached images @image_1, @image_2, ...
 */
export function buildLabVideoPrompt(story: LabStory, scene: LabScene, mode: LabVideoMode, referenceCount: number) {
  const parts = [scene.videoPrompt.trim()];
  if (mode === "startImage") parts.push("@image_1 is the first frame; keep the characters, outfits, setting and style identical to it.");
  if (mode === "references" && referenceCount) {
    const tags = Array.from({ length: referenceCount }, (_, i) => `@image_${i + 1}`);
    parts.push(
      `${tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`} ${tags.length === 1 ? "is a reference" : "are references"} for the characters, setting and style; keep them consistent.`,
    );
  }
  if (mode !== "startImage") {
    const sheet = characterSheet(story);
    if (sheet) parts.push(`Characters:\n${sheet}`);
  }
  const dialogue = scene.dialogue.trim();
  if (dialogue) {
    parts.push(
      `Spoken dialogue, said on screen by the characters with matching lip movement, in this order:\n${dialogue}\nNo narrator and no voice-over: only the characters speak.`,
    );
  } else {
    parts.push("No dialogue, no narrator and no voice-over; ambient sound only.");
  }
  return parts.join("\n\n");
}

export const LAB_ACTIVE_STATUSES = ["queued", "in_progress"] as const;
export type LabJobStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled" | "timed_out";
