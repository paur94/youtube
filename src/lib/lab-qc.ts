import { z } from "zod";

import {
  countWords,
  evaluateGate,
  GATE_GROUPS,
  type GateCheck,
  gateCheck,
  type GateGroup,
  gateMatches,
  type GateState,
  type GateStatus,
  moderationRisks,
  readGateState,
  timelineChecks,
} from "./generation-qc";
import { KLING_MAX_IMAGES } from "./kling";
import type { LabReference, LabScene, LabStory, LabVideoMode } from "./lab";
import { hashText } from "./story-qc";

// Pre-generation QC for the Adult Lab; the shared machinery and its stages are described in ./generation-qc.
// The lab's AI review and clip inspection run on OpenAI, like the rest of the lab.

/** Stored in lab_projects.qc, per scene id. */
export type LabSceneQc = GateState & { dismissed: string[] };
export type LabQcState = { scenes: Record<string, LabSceneQc> };

export function readLabSceneQc(qc: Partial<LabQcState> | null | undefined, sceneId: string): LabSceneQc {
  const s = qc?.scenes?.[sceneId];
  return { ...readGateState(s), dismissed: Array.isArray(s?.dismissed) ? s.dismissed : [] };
}

/** The clip mode generateLabVideo will use for this scene. */
export function labVideoMode(scene: Pick<LabScene, "startImageJobId">, referenceCount: number): LabVideoMode {
  return scene.startImageJobId ? "startImage" : referenceCount ? "references" : "text";
}

/** Everything that shapes a lab scene's clip, hashed: any edit to it needs a new review and approval. */
export function labContentKey(story: LabStory, scene: LabScene, references: Pick<LabReference, "id">[], aspectRatio: string) {
  return hashText(
    JSON.stringify([
      scene.videoPrompt.trim(),
      scene.dialogue.trim(),
      scene.durationSeconds,
      scene.startImageJobId,
      story.characters.map((c) => [c.name.trim(), c.look.trim()]),
      references.map((r) => r.id),
      aspectRatio,
    ]),
  );
}

export type LabStartFrame = {
  exists: boolean;
  contentType: string | null;
  /** Prompt the image was generated from ("" for a last frame or an unknown origin). */
  prompt: string;
  fromLastFrame: boolean;
};

export type LabClipState = { revision: number; inspection: "none" | "stale" | "pass" | "warn" | "fail" };

export type LabGateInput = {
  story: LabStory;
  scene: LabScene;
  index: number;
  referenceCount: number;
  start: LabStartFrame | null;
  /** The previous scene has a finished clip whose last frame could start this one. */
  previousSceneHasClip: boolean;
  previousClip: LabClipState | null;
  aiConfigured: boolean;
  contentKey: string;
  qc: LabSceneQc;
};

const NARRATOR_RE = /^\s*(narrator|voice[- ]?over|vo|v\.o\.|announcer)\s*[:(]/i;
const DIALOGUE_LINE_RE = /^\s*([^:]{1,60}):\s*\S/;

function dialogueLines(dialogue: string) {
  return dialogue
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Rule checks for one lab clip request. */
export function labGateRules(input: LabGateInput): GateCheck[] {
  const { story, scene } = input;
  const out: GateCheck[] = [];
  const add = (group: GateGroup, status: GateStatus, label: string, detail: string, extra: { fix?: string; hard?: boolean } = {}) =>
    out.push(gateCheck("rules", group, status, label, detail, extra));
  const mode = labVideoMode(scene, input.referenceCount);
  const motion = scene.videoPrompt.trim();
  const lines = dialogueLines(scene.dialogue);
  const castNames = story.characters.map((c) => c.name.trim()).filter(Boolean);

  // Request and model limits.
  if (!motion) {
    add("request", "critical", "No motion prompt", "Nothing tells Kling what happens in the clip.", { fix: "Write the motion prompt.", hard: true });
  } else if (input.start && !input.start.exists) {
    add("request", "critical", "Start frame is gone", "The image picked as start frame was deleted or never finished.", {
      fix: "Pick another start frame or clear it.",
      hard: true,
    });
  } else if (input.start && !["image/jpeg", "image/png"].includes(input.start.contentType ?? "")) {
    add("request", "critical", "Start frame format", `Kling only accepts JPEG or PNG; the start frame is ${input.start.contentType ?? "of unknown type"}.`, {
      fix: "Pick a JPEG or PNG start frame.",
      hard: true,
    });
  } else if (mode === "references" && input.referenceCount > KLING_MAX_IMAGES) {
    add("request", "warning", "Too many reference images", `Kling takes ${KLING_MAX_IMAGES} images; ${input.referenceCount - KLING_MAX_IMAGES} will be dropped.`, {
      fix: "Remove the references this scene doesn't need.",
    });
  } else {
    add(
      "request",
      "passed",
      "Request is complete",
      mode === "startImage" ? "Kling 4.0 animates the chosen start frame." : mode === "references" ? `Kling 4.0 with ${input.referenceCount} reference image${input.referenceCount === 1 ? "" : "s"}.` : "Kling 4.0 from text only.",
    );
  }
  const risky = moderationRisks(`${scene.videoPrompt}\n${scene.dialogue}`);
  if (risky.length) {
    add("request", "warning", "Likely to be blocked by moderation", `The prompt uses ${risky.map((w) => `"${w}"`).join(", ")}; providers reject explicit requests and the run is wasted.`, {
      fix: "Describe the moment without explicit wording; imply it instead.",
    });
  }

  // Frames.
  if (input.start?.exists) {
    if (input.start.fromLastFrame) add("frames", "passed", "Start frame", "Starts on the previous clip's last frame, so the cut is seamless.");
    else if (input.start.prompt && scene.imagePrompt.trim() && !input.start.prompt.includes(scene.imagePrompt.trim())) {
      add("frames", "warning", "Start frame is from an older image prompt", "The image prompt changed after the start frame was generated, so the frame may not show what the scene now describes.", {
        fix: "Generate a new image from the current image prompt, or check the frame still fits the motion prompt.",
      });
    } else add("frames", "passed", "Start frame", "Starts on an image generated from this scene's image prompt.");
  } else if (mode === "text" && castNames.length) {
    add("frames", "warning", "No visual anchor", "No start frame and no reference images: the characters' faces and outfits come from text alone and will drift between scenes.", {
      fix: "Generate the scene image and use it as start frame, or add reference images.",
    });
  }
  if (!input.start && input.previousSceneHasClip) {
    add("continuity", "warning", "Cut from the previous scene", "The previous scene has a finished clip, but this one doesn't start from its last frame, so positions, lighting and outfits may jump.", {
      fix: 'Use "Last frame → next" on the previous clip, unless a hard cut is intended.',
    });
  }

  // Dialogue against the cast and the no-narrator rule.
  const speakers = new Set<string>();
  const malformed: string[] = [];
  for (const line of lines) {
    if (NARRATOR_RE.test(line)) {
      add("consistency", "critical", "Narrator or voice-over line", `"${line.slice(0, 80)}" would be voiced off screen; clips carry only the characters' own lines.`, {
        fix: "Remove the narrator line or give it to a character on screen.",
      });
      continue;
    }
    const m = DIALOGUE_LINE_RE.exec(line);
    if (m) speakers.add(m[1].trim());
    else malformed.push(line);
  }
  if (malformed.length) {
    add("consistency", "warning", "Dialogue without a speaker", `${malformed.length} line${malformed.length === 1 ? " has" : "s have"} no "Name:" prefix, so the model has to guess who speaks.`, {
      fix: 'Write every line as "Name: line".',
    });
  }
  const castLower = new Set(castNames.map((n) => n.toLowerCase()));
  const unknown = [...speakers].filter((s) => !castLower.has(s.toLowerCase()));
  if (unknown.length) {
    add("consistency", "warning", "Speaker not in the cast", `${unknown.join(", ")} speak${unknown.length === 1 ? "s" : ""} but ${unknown.length === 1 ? "isn't" : "aren't"} in the character list, so their look is undefined.`, {
      fix: "Add them to the characters with a fixed look, or give the line to a cast member.",
    });
  }
  const unseen = [...speakers].filter((s) => castLower.has(s.toLowerCase()) && !new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(`${scene.videoPrompt}\n${scene.imagePrompt}`));
  if (unseen.length) {
    add("consistency", "warning", "Speaker never shown", `${unseen.join(", ")} speak${unseen.length === 1 ? "s" : ""} but the motion and image prompts never put them in the shot.`, {
      fix: `Say where ${unseen.join(" and ")} ${unseen.length === 1 ? "is" : "are"} in frame and that their lips move when speaking.`,
    });
  }
  if (/["“][^"”]{12,}["”]/.test(scene.videoPrompt) && lines.length) {
    add("consistency", "warning", "Dialogue in the motion prompt", "The motion prompt quotes speech as well as the dialogue field; Kling may say the lines twice or mix them up.", {
      fix: "Keep spoken lines only in the dialogue field.",
    });
  }
  if (!out.some((c) => c.group === "consistency")) add("consistency", "passed", "Dialogue and cast", lines.length ? `${speakers.size} speaker${speakers.size === 1 ? "" : "s"}, all in the cast.` : "No dialogue.");

  // Timeline: beats and speech against Kling's clip length (Kling makes exactly the requested seconds).
  out.push(
    ...timelineChecks({
      sceneSeconds: scene.durationSeconds,
      requestedSeconds: scene.durationSeconds,
      motion: scene.videoPrompt,
      spokenWords: lines.filter((l) => !NARRATOR_RE.test(l)).reduce((sum, l) => sum + countWords(l.replace(/^\s*[^:]{1,60}:\s*/, "")), 0),
    }),
  );

  // Earlier attempts.
  const prev = input.previousClip;
  if (!prev) add("history", "passed", "First attempt", "No earlier clip of this scene.");
  else if (prev.inspection === "none") {
    add("history", input.aiConfigured ? "critical" : "warning", "Previous clip not inspected", `Clip ${prev.revision} was never inspected; its mistakes would be repeated.`, {
      fix: `Inspect clip ${prev.revision}, apply its fixes, then review again.`,
    });
  } else if (prev.inspection === "fail") {
    add("history", "warning", "Previous clip failed inspection", `Clip ${prev.revision} has critical mistakes.`, {
      fix: "Apply the inspection's suggested prompt before regenerating.",
    });
  } else {
    add("history", "passed", "Previous clip inspected", prev.inspection === "stale" ? `Clip ${prev.revision} was inspected before the latest edits.` : `Clip ${prev.revision} was inspected.`);
  }

  // The AI review must have checked this exact version.
  const selection = { modelId: null, startAssetId: scene.startImageJobId };
  if (!input.aiConfigured) {
    add("request", "warning", "AI review unavailable", "OpenAI isn't configured, so only the rule checks ran. Frames were not inspected.");
  } else if (gateMatches(input.qc.review, input.contentKey, selection)) {
    add("request", "passed", "AI review is current", "The frames and the final prompt were reviewed in this exact version.");
  } else {
    add(
      "request",
      "critical",
      input.qc.review ? "AI review is out of date" : "AI review not run",
      input.qc.review ? "The scene changed since the last review (prompt, dialogue, duration, start frame, cast or references)." : "The frames and the final prompt haven't been checked yet.",
      { fix: "Save and run the AI review.", hard: true },
    );
  }
  return out;
}

export function evaluateLabGate(input: LabGateInput) {
  return evaluateGate({
    rules: labGateRules(input),
    state: input.qc,
    contentKey: input.contentKey,
    selection: { modelId: null, startAssetId: input.scene.startImageJobId },
    dismissed: input.qc.dismissed,
  });
}

/** Story-level checks shown on the story card (they don't block a single scene). */
export function labStoryChecks(topic: string, story: LabStory): GateCheck[] {
  const out: GateCheck[] = [];
  const total = story.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
  const wanted = /\b(?:duration|length|long|runtime)\b[^0-9\n]{0,20}(\d{1,3})\s*(?:s\b|sec|seconds)/i.exec(topic) ?? /\b(\d{1,3})[- ]?(?:s|sec|second)s?\b(?:[- ](?:video|clip|film|short))/i.exec(topic);
  if (wanted) {
    const target = Number(wanted[1]);
    if (Math.abs(target - total) > 1) {
      out.push(
        gateCheck("rules", "timeline", "warning", "Total length differs from the brief", `The brief asks for ${target}s; the scenes add up to ${total}s.`, {
          fix: `Adjust the scene durations so they add up to ${target}s.`,
        }),
      );
    } else out.push(gateCheck("rules", "timeline", "passed", "Total length", `The scenes add up to ${total}s, as the brief asks.`));
  }
  const looks = story.characters.filter((c) => c.name.trim() && c.look.trim().split(/\s+/).length < 8);
  if (looks.length) {
    out.push(
      gateCheck("rules", "continuity", "warning", "Thin character looks", `${looks.map((c) => c.name).join(", ")} ${looks.length === 1 ? "has" : "have"} a short look description; the face and outfit will drift between clips.`, {
        fix: "Describe age, build, face, hair, outfit and one distinctive detail.",
      }),
    );
  }
  return out;
}

// ---------- Post-generation inspection of a lab clip ----------

export const labClipReviewSchema = z.object({
  frames: z.array(z.object({ time: z.number(), description: z.string() })),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "warning"]),
      group: z.enum(GATE_GROUPS),
      timestamp: z.number().nullable(),
      label: z.string(),
      expected: z.string(),
      observed: z.string(),
      fix: z.string(),
    }),
  ),
  summary: z.string(),
  suggestedPrompt: z.string(),
});
export type LabClipReviewOutput = z.infer<typeof labClipReviewSchema>;

/** Stored in lab_jobs.qc. */
export type LabClipReport = LabClipReviewOutput & { contentKey: string; checkedAt: string; model: string };

export function readLabClipReport(value: unknown): LabClipReport | null {
  const r = value as LabClipReport | null | undefined;
  return r && Array.isArray(r.issues) && typeof r.contentKey === "string" ? r : null;
}

export function labClipStatus(report: LabClipReport | null, contentKey: string | null): LabClipState["inspection"] {
  if (!report) return "none";
  if (contentKey && report.contentKey !== contentKey) return "stale";
  if (report.issues.some((i) => i.severity === "critical")) return "fail";
  return report.issues.length ? "warn" : "pass";
}

// ---------- Gate input from a project and its jobs (same on the client and the server) ----------

export type LabGateJob = {
  id: string;
  sceneId: string;
  kind: "image" | "video";
  status: string;
  model: string;
  prompt: string;
  filePath: string | null;
  contentType: string | null;
  qc: unknown;
  createdAt: Date | string;
};

/** A scene's finished clips, oldest first, numbered from 1. */
export function labSceneClips(jobs: LabGateJob[], sceneId: string) {
  return jobs
    .filter((j) => j.sceneId === sceneId && j.kind === "video" && j.status === "completed" && j.filePath)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((job, i) => ({ job, revision: i + 1 }));
}

export function buildLabGateInput(input: {
  story: LabStory;
  sceneId: string;
  references: Pick<LabReference, "id">[];
  aspectRatio: string;
  qc: Partial<LabQcState> | null | undefined;
  jobs: LabGateJob[];
  aiConfigured: boolean;
}): LabGateInput | null {
  const index = input.story.scenes.findIndex((s) => s.id === input.sceneId);
  if (index === -1) return null;
  const scene = input.story.scenes[index];
  const contentKey = labContentKey(input.story, scene, input.references, input.aspectRatio);
  const startJob = scene.startImageJobId ? input.jobs.find((j) => j.id === scene.startImageJobId) : undefined;
  const start: LabStartFrame | null = scene.startImageJobId
    ? {
        exists: Boolean(startJob && startJob.kind === "image" && startJob.filePath),
        contentType: startJob?.contentType ?? null,
        prompt: startJob && startJob.model !== "last-frame" ? startJob.prompt : "",
        fromLastFrame: startJob?.model === "last-frame",
      }
    : null;
  const previous = index > 0 ? input.story.scenes[index - 1] : null;
  const latest = labSceneClips(input.jobs, scene.id).at(-1);
  return {
    story: input.story,
    scene,
    index,
    referenceCount: input.references.length,
    start,
    previousSceneHasClip: previous ? labSceneClips(input.jobs, previous.id).length > 0 : false,
    previousClip: latest ? { revision: latest.revision, inspection: labClipStatus(readLabClipReport(latest.job.qc), contentKey) } : null,
    aiConfigured: input.aiConfigured,
    contentKey,
    qc: readLabSceneQc(input.qc, scene.id),
  };
}
