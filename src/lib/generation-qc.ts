import { z } from "zod";

import { type HiggsfieldModel, modelDuration } from "./higgsfield";
import { supportsKeyframes } from "./kling";
import { parseTimeline } from "./production";
import { hashText } from "./story-qc";

// Pre-generation quality control, shared by the Kids Studio (production scenes) and the Adult Lab.
//
// No video is paid for until the exact version being generated has been checked and approved:
//  1. Rule checks (free, instant): request and model limits, frames, timeline, earlier attempts.
//  2. AI review (one text+vision call): looks at the start, middle and end frames and the references,
//     reads the exact prompt that will be sent, lays the action out on a timeline, and reports what
//     would go wrong. It also suggests corrections.
//  3. Approval: a person approves the version. Approval is bound to a hash of everything that shapes
//     the clip (prompt, dialogue, duration, frames, references, model), so any edit invalidates it.
//  4. After generation the clip is inspected frame by frame, with timestamps, and must be inspected
//     before the scene is generated again, so a known mistake isn't paid for twice.

export const GATE_GROUPS = ["frames", "actions", "timeline", "consistency", "continuity", "request", "history"] as const;
export type GateGroup = (typeof GATE_GROUPS)[number];

export const GATE_GROUP_LABELS: Record<GateGroup, string> = {
  frames: "Frames (start, middle, end)",
  actions: "Actions and physics",
  timeline: "Timeline",
  consistency: "Prompt consistency",
  continuity: "Visual continuity",
  request: "Request and model limits",
  history: "Earlier attempts",
};

export const GATE_STATUSES = ["critical", "warning", "passed"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export type GateCheck = {
  /** Stable while the finding is the same, so a dismissal survives re-renders but not a changed finding. */
  id: string;
  source: "rules" | "ai";
  group: GateGroup;
  status: GateStatus;
  label: string;
  detail: string;
  /** What to change, as an imperative sentence. */
  fix?: string;
  /** Can't be dismissed: the provider would reject the request, or the gate itself isn't satisfied. */
  hard?: boolean;
};

export function gateCheck(
  source: GateCheck["source"],
  group: GateGroup,
  status: GateStatus,
  label: string,
  detail: string,
  extra: { fix?: string; hard?: boolean } = {},
): GateCheck {
  return {
    id: `gate:${source}:${group}:${hashText(`${label}\n${detail}`.toLowerCase())}`,
    source,
    group,
    status,
    label,
    detail,
    ...(extra.fix?.trim() ? { fix: extra.fix.trim() } : {}),
    ...(extra.hard ? { hard: true } : {}),
  };
}

// ---------- AI review ----------

/**
 * Whether the action the prompt asks for fits the clip at all. Reported apart from the checks: an over-full
 * scene can't be fixed by rewording, so it gets one fixed finding and no suggested prompt (see reviewChecks).
 */
const gateFitSchema = z.object({ fits: z.boolean(), secondsNeeded: z.number(), detail: z.string() });
export type GateFit = z.infer<typeof gateFitSchema>;

export const gateReviewOutputSchema = z.object({
  fit: gateFitSchema,
  frames: z.array(z.object({ image: z.string(), description: z.string() })),
  beats: z.array(z.object({ startSeconds: z.number(), endSeconds: z.number(), action: z.string() })),
  checks: z.array(
    z.object({
      group: z.enum(GATE_GROUPS),
      status: z.enum(GATE_STATUSES),
      label: z.string(),
      detail: z.string(),
      fix: z.string(),
    }),
  ),
  promptAdditions: z.string(),
  suggestedPrompt: z.string(),
  summary: z.string(),
});
export type GateReviewOutput = z.infer<typeof gateReviewOutputSchema>;

export type GateBeat = GateReviewOutput["beats"][number];

/** A saved AI review. `contentKey` + `modelId` + `startAssetId` say exactly which version it checked. */
export type GateReview = {
  contentKey: string;
  modelId: string | null;
  startAssetId: string | null;
  checkedAt: string;
  model: string;
  frames: GateReviewOutput["frames"];
  beats: GateBeat[];
  checks: GateCheck[];
  /** Missing on reviews saved before the fit verdict existed. */
  fit?: GateFit;
  /** The prompt text this review read (lab: motion prompt; kids: action), to tell whether its suggestion was applied. */
  reviewedText?: string;
  promptAdditions: string;
  suggestedPrompt: string;
  /** Lab only: a corrected image prompt, when the start frame can't begin the action. */
  suggestedImagePrompt?: string;
  summary: string;
};

export type GateApproval = { contentKey: string; modelId: string | null; startAssetId: string | null; approvedAt: string };

export type GateState = { review: GateReview | null; approval: GateApproval | null };

export const EMPTY_GATE_STATE: GateState = { review: null, approval: null };

export function readGateState(value: Partial<GateState> | null | undefined): GateState {
  return { review: value?.review ?? null, approval: value?.approval ?? null };
}

export function toGateChecks(items: GateReviewOutput["checks"]): GateCheck[] {
  return items
    .filter((c) => c.label.trim() || c.detail.trim())
    .map((c) => gateCheck("ai", c.group, c.status, c.label.trim() || c.detail.trim(), c.detail.trim(), { fix: c.fix }));
}

/** Most a clip can be (Kling); beyond it an over-full scene has to be split. */
const MAX_CLIP_SECONDS = 30;

/** The finding for an action that doesn't fit the clip; null when it fits. */
export function fitCheck(fit: GateFit | undefined, clipSeconds: number): GateCheck | null {
  if (!fit || fit.fits) return null;
  const needed = Math.max(clipSeconds + 1, Math.ceil(fit.secondsNeeded));
  const scenes = Math.ceil(needed / Math.min(clipSeconds, MAX_CLIP_SECONDS));
  return gateCheck(
    "ai",
    "timeline",
    "critical",
    `The action doesn't fit in ${clipSeconds}s`,
    `${fit.detail.trim()} It needs about ${needed}s. Rewording the prompt can't fix this, so no suggested prompt was written.`.trim(),
    {
      fix:
        needed <= MAX_CLIP_SECONDS
          ? `Raise the scene to ${needed}s, split it into ${scenes} scenes, or cut events until it fits ${clipSeconds}s.`
          : `Split it into ${scenes} scenes, or cut events until it fits ${clipSeconds}s.`,
    },
  );
}

/** A review's findings: the fit verdict first (when the action doesn't fit), then the reviewer's checks. */
export function reviewChecks(output: Pick<GateReviewOutput, "fit" | "checks">, clipSeconds: number): GateCheck[] {
  const fit = fitCheck(output.fit, clipSeconds);
  return [...(fit ? [fit] : []), ...toGateChecks(output.checks)];
}

/**
 * The last review, as input for the next one, so the reviewer verifies its own earlier findings instead of
 * starting over and digging deeper each round. Null when there is no earlier review.
 */
export function previousReviewLines(review: GateReview | null | undefined, currentText: string): string[] | null {
  if (!review) return null;
  const open = review.checks.filter((c) => c.status !== "passed");
  const applied = Boolean(review.suggestedPrompt.trim()) && review.suggestedPrompt.trim() === currentText.trim();
  const changed = review.reviewedText !== undefined && review.reviewedText.trim() !== currentText.trim();
  return [
    applied
      ? "The prompt now under review IS the suggested prompt from that review, applied unchanged."
      : changed
        ? "The prompt was edited since that review."
        : "The prompt may or may not have changed since that review.",
    ...(open.length
      ? open.map((c) => `- [${c.status}] (${c.group}) ${c.label}: ${c.detail}${c.fix ? ` Fix given: ${c.fix}` : ""}`)
      : ["(it found no critical issues or warnings)"]),
  ];
}

export type GateSelection = {
  /** null matches any model (e.g. Hedra, which has no catalog model to review against). */
  modelId: string | null;
  startAssetId: string | null;
};

/** True when a saved review or approval is for this exact version. */
export function gateMatches(
  record: { contentKey: string; modelId: string | null; startAssetId: string | null } | null | undefined,
  contentKey: string,
  selection: GateSelection,
) {
  if (!record || record.contentKey !== contentKey) return false;
  if ((record.startAssetId ?? null) !== (selection.startAssetId ?? null)) return false;
  return selection.modelId === null || record.modelId === selection.modelId;
}

export type GateEvaluation = {
  checks: GateCheck[];
  critical: GateCheck[];
  warnings: GateCheck[];
  passed: GateCheck[];
  dismissed: GateCheck[];
  reviewCurrent: boolean;
  review: GateReview | null;
  approved: boolean;
  /** Approval needs every critical finding resolved (fixed, or dismissed when it can be). */
  canApprove: boolean;
  canGenerate: boolean;
};

/**
 * Combines rule checks with the saved review (only when it checked this exact version) and the
 * person's dismissals. Hard checks can't be dismissed.
 */
export function evaluateGate(input: {
  rules: GateCheck[];
  state: GateState;
  contentKey: string;
  selection: GateSelection;
  dismissed: Iterable<string>;
}): GateEvaluation {
  const reviewCurrent = gateMatches(input.state.review, input.contentKey, input.selection);
  const review = reviewCurrent ? input.state.review : null;
  const checks = [...input.rules, ...(review?.checks ?? [])];
  const skip = new Set(input.dismissed);
  const isDismissed = (c: GateCheck) => c.status !== "passed" && !c.hard && skip.has(c.id);
  const open = checks.filter((c) => !isDismissed(c));
  const critical = open.filter((c) => c.status === "critical");
  const approved = gateMatches(input.state.approval, input.contentKey, input.selection);
  return {
    checks,
    critical,
    warnings: open.filter((c) => c.status === "warning"),
    passed: open.filter((c) => c.status === "passed"),
    dismissed: checks.filter(isDismissed),
    reviewCurrent,
    review,
    approved,
    canApprove: critical.length === 0,
    canGenerate: approved && critical.length === 0,
  };
}

/** One line for an error message: why this version can't be generated yet, or null. */
export function gateBlocker(evaluation: GateEvaluation) {
  const first = evaluation.critical[0];
  if (first) {
    return `Pre-generation QC: ${evaluation.critical.length} critical issue${evaluation.critical.length === 1 ? "" : "s"} (${first.label}). Resolve ${evaluation.critical.length === 1 ? "it" : "them"} and approve the version first.`;
  }
  if (!evaluation.approved) return "Pre-generation QC: review the QC report and approve this exact version before generating.";
  return null;
}

// ---------- Rule checks shared by both studios ----------

/** About what a person says in a second at a natural pace; video models lip-sync up to roughly this. */
export const WORDS_PER_SECOND = 2.5;
/** Shortest beat a video model reliably shows as its own action. */
export const MIN_BEAT_SECONDS = 1;
/** Rough time one distinct action needs on screen. */
export const SECONDS_PER_ACTION = 1.5;

export function countWords(text: string) {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Distinct actions in an untimed motion text: sentences and "then"/"and then" clauses. */
export function countActions(text: string) {
  return text
    .split(/[.;!?\n]+|\b(?:and then|then|after that|afterwards|finally|meanwhile)\b/i)
    .map((s) => s.trim())
    .filter((s) => countWords(s) >= 3).length;
}

/**
 * Timeline checks: the clip length the model will actually produce, timed beats that must fit it
 * without gaps or overlaps, how much action is packed into each second, and (optionally) whether the
 * spoken lines fit.
 */
export function timelineChecks(input: {
  sceneSeconds: number;
  /** Seconds the model will be asked for (models clamp or round), or null when unknown. */
  requestedSeconds: number | null;
  /** The motion text: the scene's action (kids) or motion prompt (lab). */
  motion: string;
  /** Words of on-screen dialogue, when the speaking pace should be checked here. */
  spokenWords?: number;
}): GateCheck[] {
  const out: GateCheck[] = [];
  const add = (status: GateStatus, label: string, detail: string, fix?: string) => out.push(gateCheck("rules", "timeline", status, label, detail, { fix }));
  const clip = input.requestedSeconds ?? input.sceneSeconds;

  if (input.requestedSeconds !== null && input.requestedSeconds !== input.sceneSeconds) {
    if (input.requestedSeconds < input.sceneSeconds) {
      add(
        "critical",
        "The model makes a shorter clip than the scene",
        `The scene is ${input.sceneSeconds}s but the model will produce ${input.requestedSeconds}s, so the end of the action and dialogue would be cut.`,
        `Shorten the scene to ${input.requestedSeconds}s or pick a model that makes ${input.sceneSeconds}s clips.`,
      );
    } else {
      add(
        "warning",
        "The model makes a longer clip than the scene",
        `The scene is ${input.sceneSeconds}s but the model will produce ${input.requestedSeconds}s; the extra ${input.requestedSeconds - input.sceneSeconds}s has no planned action and the model will improvise.`,
        `Set the scene to ${input.requestedSeconds}s and plan the extra time.`,
      );
    }
  }

  // "0–2 seconds:" is a common way to time beats; the shared parser reads "0–2s:".
  const motion = input.motion.replace(/(\d)\s*(?:seconds?|secs?)\b/gi, "$1s");
  const { segments } = parseTimeline(motion);
  if (segments.length) {
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const problems: string[] = [];
    let critical = false;
    for (const [i, s] of sorted.entries()) {
      if (s.end > clip + 0.25) {
        critical = true;
        problems.push(`beat ${i + 1} (${s.start}-${s.end}s) runs past the ${clip}s clip`);
      }
      if (s.end - s.start < MIN_BEAT_SECONDS) problems.push(`beat ${i + 1} lasts only ${+(s.end - s.start).toFixed(2)}s`);
      const actions = Math.max(1, countActions(s.text));
      // Sentence counts include description, so only an extreme density is reported.
      if (actions >= 3 && (s.end - s.start) / actions < SECONDS_PER_ACTION / 3) {
        problems.push(`beat ${i + 1} packs ${actions} actions into ${+(s.end - s.start).toFixed(2)}s`);
      }
      const next = sorted[i + 1];
      if (next && next.start < s.end - 0.05) problems.push(`beats ${i + 1} and ${i + 2} overlap (fine only if they are simultaneous actions of different characters)`);
      if (next && next.start > s.end + 1) problems.push(`nothing is planned between ${s.end}s and ${next.start}s`);
    }
    if (sorted[0].start > 1) problems.push(`nothing is planned for the first ${sorted[0].start}s`);
    const last = sorted.at(-1)!;
    if (last.end < clip - 1.5) problems.push(`the last ${+(clip - last.end).toFixed(1)}s have no planned action`);
    if (problems.length) {
      add(
        critical ? "critical" : "warning",
        critical ? "Timed beats don't fit the clip" : "Timed beats need adjusting",
        `${problems.join("; ")}.`,
        `Re-time the beats so they run from 0 to ${clip}s without gaps or overlaps, about ${SECONDS_PER_ACTION}-2s per action.`,
      );
    } else {
      add("passed", "Timed beats fit the clip", `${sorted.length} beat${sorted.length === 1 ? "" : "s"} cover 0-${last.end}s of the ${clip}s clip without gaps or overlaps.`);
    }
  } else {
    const actions = countActions(motion);
    if (!actions) {
      add("warning", "No action described", "The motion text describes no action, so the model will improvise the whole clip.", "Describe what happens, in order.");
    } else if (actions * SECONDS_PER_ACTION > clip) {
      // A sentence count is a rough guess (descriptions count too), so it warns; the AI review judges the action.
      add(
        "warning",
        "Too much action for the clip length",
        `${actions} distinct actions in ${clip}s is about ${(clip / actions).toFixed(1)}s each; video models need ${SECONDS_PER_ACTION}-2s per action and drop or rush the rest.`,
        `Cut the action to ${Math.max(1, Math.floor(clip / 2))} actions or lengthen the clip.`,
      );
    } else if (actions >= 3) {
      add(
        "warning",
        "Several actions without timing",
        `${actions} actions in ${clip}s with no timing; models often reorder or merge untimed actions.`,
        `Write the action as timed beats ("0-3s: ...", "3-6s: ...") that cover the ${clip}s.`,
      );
    } else {
      add("passed", "Action fits the clip", `${actions} action${actions === 1 ? "" : "s"} in ${clip}s.`);
    }
  }

  if (input.spokenWords !== undefined) {
    const pace = clip > 0 ? input.spokenWords / clip : 0;
    if (!input.spokenWords) {
      add("passed", "No dialogue to fit", "Nobody speaks in this clip.");
    } else if (pace > WORDS_PER_SECOND + 1) {
      add(
        "critical",
        "Dialogue doesn't fit the clip",
        `${input.spokenWords} words in ${clip}s (${pace.toFixed(1)} words/s) can't be spoken and lip-synced; the model will cut or garble lines.`,
        `Cut the dialogue to about ${Math.floor(clip * WORDS_PER_SECOND)} words.`,
      );
    } else if (pace > WORDS_PER_SECOND) {
      add(
        "warning",
        "Dialogue is rushed",
        `${input.spokenWords} words in ${clip}s (${pace.toFixed(1)} words/s) is faster than natural speech (${WORDS_PER_SECOND}/s).`,
        `Trim the dialogue to about ${Math.floor(clip * WORDS_PER_SECOND)} words.`,
      );
    } else {
      add("passed", "Dialogue fits the clip", `${input.spokenWords} words in ${clip}s (${pace.toFixed(1)} words/s).`);
    }
  }
  return out;
}

/** Words that providers' moderation commonly rejects; a rejected request is still billed or wasted. */
const MODERATION_RISKS = [
  "nude", "naked", "nudity", "topless", "sex", "sexual", "porn", "explicit", "genitals", "gore", "gory",
  "dismember", "decapitat", "disembowel", "mutilat", "beheading", "self-harm", "suicide",
];

export function moderationRisks(text: string) {
  const t = text.toLowerCase();
  return MODERATION_RISKS.filter((w) => new RegExp(`\\b${w}`).test(t));
}

// ---------- Kids Studio (production scenes) ----------

export type KidsStartImage = { label: string; sceneKeyframe: boolean; contentType: string | null };

export type PreviousClip = {
  revision: number;
  /** "none": never inspected; "stale": inspected against an older script. */
  inspection: "none" | "stale" | "pass" | "warn" | "fail";
};

/** Everything the Kids Studio gate reads, computed on the server once and evaluated per model/start pick. */
export type KidsGateContext = {
  contentKey: string;
  durationSeconds: number;
  action: string;
  startImages: Record<string, KidsStartImage>;
  frames: { middle: number; end: boolean; missing: number };
  storyQc: { openCritical: string[]; preflightCurrent: boolean; preflightStale: boolean };
  previousClip: PreviousClip | null;
  aiConfigured: boolean;
  state: GateState;
  dismissed: string[];
};

export type KidsGateModel = {
  id: string;
  label: string;
  input: "text" | "image";
  keyframes: boolean;
  /** Clip length the model will be asked for. */
  requestedSeconds: number | null;
};

export function kidsGateModel(model: HiggsfieldModel, sceneSeconds: number): KidsGateModel {
  return {
    id: model.id,
    label: model.label,
    input: model.input,
    keyframes: supportsKeyframes(model),
    requestedSeconds: modelDuration(model, sceneSeconds),
  };
}

const KLING_TYPES = ["image/jpeg", "image/png"];

/** Rule checks for one Kids Studio clip request. `model` null is Hedra (audio-driven, any length). */
export function kidsGateRules(ctx: KidsGateContext, model: KidsGateModel | null, startAssetId: string | null): GateCheck[] {
  const out: GateCheck[] = [];
  const add = (group: GateGroup, status: GateStatus, label: string, detail: string, extra: { fix?: string; hard?: boolean } = {}) =>
    out.push(gateCheck("rules", group, status, label, detail, extra));
  const needsStart = model ? model.input === "image" : true;
  const start = startAssetId ? ctx.startImages[startAssetId] : undefined;

  // Request and model limits.
  if (needsStart && !start) {
    add("request", "critical", "No start image", `${model?.label ?? "Hedra"} animates a start image, and none is chosen.`, {
      fix: "Approve a keyframe for this scene and pick it as the start image.",
      hard: true,
    });
  } else if (start && model?.keyframes && !KLING_TYPES.includes(start.contentType ?? "")) {
    add("request", "critical", "Start image format", `Kling only accepts JPEG or PNG; the start image is ${start.contentType ?? "of unknown type"}.`, {
      fix: "Choose a JPEG or PNG start image.",
      hard: true,
    });
  } else {
    add("request", "passed", "Request is complete", needsStart ? `Start image: ${start?.label}.` : "Text-to-video: no start image needed.");
  }

  // Frames.
  if (start) {
    if (start.sceneKeyframe) add("frames", "passed", "Start frame", `Starts on this scene's approved keyframe (${start.label}).`);
    else {
      add("frames", "warning", "Start frame isn't this scene's keyframe", `The clip opens on "${start.label}" instead of the composition approved for this scene.`, {
        fix: "Use this scene's own approved keyframe as the start image, or confirm this frame is intended.",
      });
    }
  }
  if (model?.keyframes && needsStart) {
    if (ctx.frames.missing) {
      add("frames", "critical", "Saved keyframes are missing", `${ctx.frames.missing} saved middle/end keyframe${ctx.frames.missing === 1 ? " was" : "s were"} deleted or rejected.`, {
        fix: "Update the keyframes under the model settings and save them.",
        hard: true,
      });
    } else if (ctx.frames.middle || ctx.frames.end) {
      add(
        "frames",
        "passed",
        "Keyframes",
        `${ctx.frames.middle} middle frame${ctx.frames.middle === 1 ? "" : "s"}${ctx.frames.end ? " and an end frame" : ""} go with the start frame.`,
      );
    } else if ((model.requestedSeconds ?? ctx.durationSeconds) > 10) {
      add("frames", "warning", "Long clip with only a start frame", "Nothing pins where a clip over 10s ends; models drift in long clips.", {
        fix: "Add an end frame (or middle frames) that shows where the action lands.",
      });
    }
  }

  // Story QC (script vs prompt) feeds the gate: its criticals are resolved on the Story QC card.
  if (ctx.storyQc.openCritical.length) {
    add(
      "consistency",
      "critical",
      "Story QC has open critical issues",
      `${ctx.storyQc.openCritical.length} script contradiction${ctx.storyQc.openCritical.length === 1 ? "" : "s"}: ${ctx.storyQc.openCritical[0]}`,
      { fix: "Apply the prompt corrections or dismiss the issue on the Story QC card.", hard: true },
    );
  } else {
    add("consistency", "passed", "Story QC", "No open critical contradictions between the script and the prompt.");
  }
  if (!ctx.storyQc.preflightCurrent) {
    add(
      "consistency",
      "warning",
      ctx.storyQc.preflightStale ? "Claude story check is out of date" : "Claude story check not run",
      ctx.storyQc.preflightStale
        ? "The script changed since the whole-story check, so the shot list and continuity bible may be wrong."
        : "Without the whole-story check there is no shot list or continuity bible to compare against.",
      { fix: "Run the story check on the plan page." },
    );
  }

  // Timeline: the model's real clip length against the timed action.
  out.push(...timelineChecks({ sceneSeconds: ctx.durationSeconds, requestedSeconds: model?.requestedSeconds ?? null, motion: ctx.action }));

  // Earlier attempts must be inspected before paying for another one.
  const prev = ctx.previousClip;
  if (!prev) add("history", "passed", "First attempt", "No earlier clip of this scene.");
  else if (prev.inspection === "none") {
    add(
      "history",
      ctx.aiConfigured ? "critical" : "warning",
      "Previous clip not inspected",
      `Clip r${prev.revision} was never compared with the story; its mistakes would be repeated.`,
      { fix: `Inspect clip r${prev.revision} ("Inspect vs story"), apply its corrections, then review again.` },
    );
  } else if (prev.inspection === "fail") {
    add("history", "warning", "Previous clip failed inspection", `Clip r${prev.revision} has critical mismatches with the story.`, {
      fix: "Apply the prompt corrections so the vision findings are in the prompt before regenerating.",
    });
  } else {
    add(
      "history",
      "passed",
      "Previous clip inspected",
      prev.inspection === "stale" ? `Clip r${prev.revision} was inspected against an earlier script.` : `Clip r${prev.revision} was inspected (${prev.inspection === "pass" ? "matches the story" : "minor mismatches"}).`,
    );
  }

  out.push(reviewRule(ctx.state, ctx.contentKey, { modelId: model?.id ?? null, startAssetId: needsStart ? startAssetId : null }, ctx.aiConfigured, "OpenAI"));
  return out;
}

/** The AI review must have checked this exact version (when an AI provider is configured). */
function reviewRule(state: GateState, contentKey: string, selection: GateSelection, configured: boolean, provider: string): GateCheck {
  if (!configured) {
    return gateCheck("rules", "request", "warning", "AI review unavailable", `${provider} isn't configured, so only the rule checks ran. Frames were not inspected.`);
  }
  if (gateMatches(state.review, contentKey, selection)) {
    return gateCheck("rules", "request", "passed", "AI review is current", `Reviewed ${new Date(state.review!.checkedAt).toISOString().slice(0, 16).replace("T", " ")} UTC against this exact version.`);
  }
  return gateCheck(
    "rules",
    "request",
    "critical",
    state.review ? "AI review is out of date" : "AI review not run",
    state.review ? "Something that shapes the clip changed since the last review (prompt, frames, model or duration)." : "The frames and the final prompt haven't been checked yet.",
    { fix: "Run the AI review.", hard: true },
  );
}

/** Everything that shapes a production scene's clip, hashed. Corrections in the visual prompt count. */
export function kidsContentKey(input: {
  visualPrompt: string;
  action: string;
  setting: string;
  dialogue: { character: string; line: string }[];
  durationSeconds: number;
  negativePrompt: string;
  visualStyle: string | null;
  characters: { name: string; visualDescription: string }[];
  middleAssetIds: string[];
  endAssetId: string | null;
  referenceAssetIds: string[];
}) {
  return hashText(
    JSON.stringify([
      input.visualPrompt.trim(),
      input.action.trim(),
      input.setting.trim(),
      input.dialogue.map((d) => [d.character.trim(), d.line.trim()]),
      input.durationSeconds,
      input.negativePrompt.trim(),
      (input.visualStyle ?? "").trim(),
      input.characters.map((c) => [c.name, c.visualDescription.trim()]).sort(),
      input.middleAssetIds,
      input.endAssetId,
      [...input.referenceAssetIds].sort(),
    ]),
  );
}

export function evaluateKidsGate(ctx: KidsGateContext, model: KidsGateModel | null, startAssetId: string | null) {
  const needsStart = model ? model.input === "image" : true;
  const selection = { modelId: model?.id ?? null, startAssetId: needsStart ? startAssetId : null };
  return evaluateGate({
    rules: kidsGateRules(ctx, model, startAssetId),
    state: ctx.state,
    contentKey: ctx.contentKey,
    selection,
    dismissed: ctx.dismissed,
  });
}
