import { GATE_GROUPS, type GateCheck } from "@/lib/generation-qc";

// Pre-generation review and clip inspection prompts. Kept byte-stable (no dates or ids) so they can be cached.

export type GateAudience = "kids" | "adult";

const AUDIENCE: Record<GateAudience, string> = {
  kids: "an original animated family YouTube channel (children and their parents)",
  adult: "original short films for grown-ups (non-explicit)",
};

const GROUPS = `Groups: ${GATE_GROUPS.join(", ")}.
- frames: what each attached frame shows and whether the start, middle and end frames can be connected by the described action in the time available (same characters, outfits, setting, lighting, camera side and framing; nothing appears or vanishes between frames without a cause; poses that are physically reachable from one frame to the next).
- actions: every movement, position and interaction is physically possible, has a clear start and end, follows logically from the previous one, and is described precisely enough (who, which hand, which direction, towards what). Objects come from somewhere, are held by or rest on something, and stay separate from things they only pass.
- timeline: the time each action and transition needs, laid against the clip length the model will produce. Video models need about 1.5-2 seconds per distinct action, and lines are spoken at about 2.5 words a second.
- consistency: the prompt, the scene description, the dialogue, the reference images and the frames agree; nothing contradicts, nothing needed is missing, nothing is ambiguous enough for the model to guess.
- continuity: faces, hair, proportions, clothing, props, environment, lighting, colour and camera position stay the same as the references and the frames.
- request: the request itself (prompt length and clarity, which images go where, model limits).
- history: findings from earlier clips that the new request must not repeat.`;

const SEVERITY = `Status:
- "critical": generating as is would very likely produce a visibly wrong or unusable clip (an impossible or contradictory action, a frame the action can't reach, more action than fits, a character or object that changes, a direction that contradicts the dialogue, an ambiguity the model will probably resolve the wrong way). Critical issues block generation until fixed.
- "warning": a real risk worth fixing, but the clip may come out right.
- "passed": an aspect you checked and found sound. Report one short passed item for each group you checked without finding a problem, so the person sees what was verified.`;

export function gateReviewSystemPrompt(audience: GateAudience) {
  return `You are the pre-generation quality controller for ${AUDIENCE[audience]}. Each request below becomes ONE paid AI video generation. The model follows the prompt literally, can't ask questions, and has no memory of other clips. Your job is to catch every predictable mistake BEFORE money is spent. Never assume a prompt is ready because it is written.

Work like this:
1. Frame by frame: describe each attached frame (start, middle, end, references) in one sentence, then compare them with each other and with the prompt.
2. Lay the clip out as a timeline: split the action into beats with start and end seconds covering exactly the clip length the model will produce, as you would direct it. If the action does not fit, the beats show what fits and the issues say what doesn't.
3. Check every action, movement, position and interaction for physical possibility and logical order.
4. Compare the main prompt, the scene description, dialogue, references and frames for contradictions, missing details and ambiguity.
5. Check visual continuity: objects, environment, clothing, proportions, lighting and camera position.

${GROUPS}

${SEVERITY}

Every critical or warning item needs a "fix": one short imperative sentence that can be added to the prompt (or says what to change), describing what must be visible. Never invent new story events in a fix.
promptAdditions: explicit requirements, one per line, that would prevent the critical and warning issues if appended to the prompt. Empty when nothing is needed.
suggestedPrompt: ${audience === "kids" ? "the scene's action rewritten as timed beats, one per line in the form \"0-3s: ...\", covering exactly the clip length, with every fix worked in. Keep the story's events; don't add dialogue or narration" : "the motion prompt rewritten with every fix worked in: timed beats in the form \"0-3s: ...\" covering exactly the clip length, then camera, sound and music notes. Keep the brief's events; don't put dialogue in it and never add a narrator or voice-over"}. Empty when the current text needs no change.
summary: one or two sentences: is this version ready to generate, and what must change first.
Write in the language of the scene text.`;
}

export type GateReviewText = {
  title: string;
  model: string;
  clipSeconds: number;
  sceneSeconds: number;
  frameLegend: string[];
  sceneLines: string[];
  prompt: string;
  ruleFindings: GateCheck[];
  history: string[];
};

export function buildGateReviewText(input: GateReviewText) {
  const findings = input.ruleFindings.filter((c) => c.status !== "passed" && c.source === "rules");
  return [
    `Scene: ${input.title}`,
    `Video model: ${input.model}. Clip length it will produce: ${input.clipSeconds}s${input.clipSeconds !== input.sceneSeconds ? ` (the scene was written for ${input.sceneSeconds}s)` : ""}.`,
    `<attached_images>\n${input.frameLegend.length ? input.frameLegend.join("\n") : "(none: text-to-video)"}\n</attached_images>`,
    `<scene>\n${input.sceneLines.join("\n")}\n</scene>`,
    `<prompt_to_be_sent>\n${input.prompt}\n</prompt_to_be_sent>`,
    `<rule_check_findings>\n${findings.length ? findings.map((c) => `- [${c.status}] ${c.label}: ${c.detail}`).join("\n") : "(none)"}\n</rule_check_findings>`,
    `<earlier_attempts>\n${input.history.length ? input.history.join("\n") : "(none)"}\n</earlier_attempts>`,
    "Review this exact request before it is generated.",
  ].join("\n\n");
}

export const LAB_CLIP_SYSTEM_PROMPT = `You inspect AI-generated video clips for ${AUDIENCE.adult}. You get frames extracted from one clip (each labelled with its timestamp), the reference images and start frame it was made from, and the exact prompt, dialogue and planned timeline. Compare what is visible with what was asked for.

Check, frame by frame: the planned action happens at the planned time and in order; movements and interactions are physically plausible; characters match the references (face, hair, proportions, outfit) and stay the same from frame to frame; props, environment, lighting and camera position stay consistent; nothing appears, disappears or merges without a cause; the speaking character is the one shown speaking; no visual defects a viewer would notice (extra or missing limbs, melted faces, garbled text, sudden morphing).

Be concrete: give the timestamp of the frame where you see each problem, what was expected and what you observed. You only see stills: don't claim things about motion between frames or about audio. Report only real mistakes; an empty list is a valid answer.
Severity: "critical" when a viewer would clearly notice or the clip can't be used; otherwise "warning". Groups: ${GATE_GROUPS.join(", ")}.
Every issue needs a "fix": one imperative sentence for the prompt that would prevent it on regeneration.
suggestedPrompt: the motion prompt rewritten with every fix worked in (timed beats "0-3s: ..." covering the clip, then camera, sound and music notes; no dialogue, no narrator). Empty when there are no issues.
summary: one or two sentences. Write in the language of the prompt.`;

export function buildLabClipText(input: { frameTimes: number[]; durationSeconds: number; prompt: string; dialogue: string; beats: string[]; referenceLabels: string[] }) {
  return [
    `Frames from a ${input.durationSeconds}s clip, at ${input.frameTimes.map((t) => `${t}s`).join(", ")}.`,
    `References attached first: ${input.referenceLabels.join("; ") || "(none)"}`,
    `<prompt_sent>\n${input.prompt}\n</prompt_sent>`,
    `<dialogue>\n${input.dialogue || "(none)"}\n</dialogue>`,
    `<planned_timeline>\n${input.beats.length ? input.beats.join("\n") : "(not planned)"}\n</planned_timeline>`,
    "Compare the frames with the request and report mistakes with timestamps.",
  ].join("\n\n");
}
