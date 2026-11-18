import { z } from "zod";

import { describeKlingFrames } from "./kling";

// Adult Lab: a single-page test bench for stories aimed at grown-up audiences. Topic and reference images go
// in, GPT (OpenAI) writes an editable story split into clips, and each clip gets a Grok Image 2.0 keyframe and a
// Kling 4.0 clip. It skips the kids pipeline (story QC, characters, production plans) on purpose, but every clip
// still passes its own pre-generation QC and approval (./lab-qc) before it is paid for.

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
/**
 * Room for a full shot spec (setup, roles, timed beats, end state) of a 30s clip. Kling 4.0 itself takes far
 * more (below), but past this a prompt is padding: precision comes from structure, not length.
 */
export const LAB_VIDEO_PROMPT_MAX = 8000;
/** Kling 4.0's documented prompt limits (Replicate README, November 2026). */
export const KLING_PROMPT_MAX_CHARS = 26_000;
export const KLING_PROMPT_MAX_CHARS_NON_ENGLISH = 11_000;

/** The limit that applies to a prompt: the lower one as soon as a real share of it isn't Latin script. */
export function klingPromptLimit(prompt: string) {
  const letters = prompt.match(/\p{L}/gu) ?? [];
  const nonLatin = letters.filter((c) => !/\p{Script=Latin}/u.test(c)).length;
  return nonLatin > letters.length * 0.1 ? KLING_PROMPT_MAX_CHARS_NON_ENGLISH : KLING_PROMPT_MAX_CHARS;
}

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
  videoPrompt: z.string().max(LAB_VIDEO_PROMPT_MAX),
  dialogue: z.string().max(4000),
  durationSeconds: z.number().int().min(LAB_MIN_SECONDS).max(LAB_MAX_SECONDS),
  /** Generated image used as the clip's first frame; null sends the reference images instead. */
  startImageJobId: z.string().nullable(),
  /** Image the clip must end on (Kling end_image); only sent together with a start frame. */
  endImageJobId: z.string().nullable().optional(),
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

/** True when the scene's end frame will actually be sent: Kling takes it only with a start frame. */
export function labSendsEndFrame(scene: Pick<LabScene, "startImageJobId" | "endImageJobId">) {
  return Boolean(scene.startImageJobId && scene.endImageJobId);
}

/**
 * Prompt for the scene's Kling clip. Only the characters' own spoken lines go in: no narrator or voice-over.
 * Kling numbers attached images @image_1, @image_2, ... (start, end, then references).
 *
 * With a start frame the cast sheet still goes along, briefly: the motion prompt names the characters, and
 * without it Kling can't tell which figure in the frame is which and gives the action to the wrong one.
 */
/** The motion prompt plans its own audio: a Sound line, music or effects. */
const PLANNED_SOUND_RE = /^\s*sound\s*:|\b(?:music|score|soundtrack|sound effects?|sfx)\b/im;

export function buildLabVideoPrompt(story: LabStory, scene: LabScene, mode: LabVideoMode, referenceCount: number) {
  const parts = [scene.videoPrompt.trim()];
  const sheet = characterSheet(story);
  if (mode === "startImage") {
    parts.push(
      labSendsEndFrame(scene)
        ? `${describeKlingFrames({ middle: 0, end: true })} The clip ends exactly on the last frame's positions and poses.`
        : "@image_1 is the first frame; keep the characters, outfits, setting and style identical to it.",
    );
    if (sheet) parts.push(`Cast, to tell the figures in @image_1 apart (their look is already in the frame; don't change it):\n${sheet}`);
  }
  // When the motion prompt already says what each @image_N is for, a generic line here would contradict it.
  if (mode === "references" && referenceCount && !/@image_\d/i.test(scene.videoPrompt)) {
    const tags = Array.from({ length: referenceCount }, (_, i) => `@image_${i + 1}`);
    parts.push(
      `${tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`} ${tags.length === 1 ? "is a reference" : "are references"} for the characters and the style; keep them consistent. The setting is the one described above.`,
    );
  }
  if (mode !== "startImage" && sheet) parts.push(`Characters:\n${sheet}`);
  const dialogue = scene.dialogue.trim();
  if (dialogue) {
    parts.push(
      `Spoken dialogue, said on screen by the characters with matching lip movement, in this order:\n${dialogue}\nNo narrator and no voice-over: only the characters speak.`,
    );
  } else {
    // "Ambient sound only" would cancel music or effects the motion prompt asks for.
    parts.push(PLANNED_SOUND_RE.test(scene.videoPrompt) ? "No dialogue, no narrator and no voice-over." : "No dialogue, no narrator and no voice-over; ambient sound only.");
  }
  return parts.join("\n\n");
}

export const LAB_ACTIVE_STATUSES = ["queued", "in_progress"] as const;
export type LabJobStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled" | "timed_out";
