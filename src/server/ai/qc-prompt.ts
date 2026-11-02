import { type ContinuityBible, describeShots, type QcScene, type ShotSpec } from "@/lib/story-qc";

// Kept byte-stable (no dates or ids) so they can be prompt-cached.

const ISSUE_RULES = `Severity:
- "critical": a viewer would notice the story and the picture disagree, e.g. a character says "look behind you" while everyone keeps facing forward; dialogue names a lake that isn't on screen; the narration counts three apples but a different number is shown; someone points the wrong way; the speaker isn't the one whose lips move; a character's outfit, colours or a prop changes between shots without a reason.
- "warning": likely to go wrong in generation or to confuse a child, but not a contradiction yet (ambiguous direction, unclear who is where, an object that should probably be visible).
- "info": a suggestion.
Categories: gaze, unseen_object, quantity, direction, dialogue_action, speaker, appearance, prop_continuity, environment, reference, timing, visual_quality, other.
Every issue needs a "fix": one short imperative sentence that can be appended to the video prompt to prevent it, describing what must be visible (e.g. "Mila turns her head and body around to look behind her at the lake."). Never invent new story events in a fix.`;

export const PREFLIGHT_SYSTEM_PROMPT = `You are the continuity supervisor for an original animated children's YouTube channel. Each scene below is turned into one AI-generated video clip by a text-to-video model that follows the prompt literally and has no memory between clips. Your job is to catch logical mistakes in the script BEFORE money is spent on generation.

For the whole story:
- Build a continuity bible: every character's fixed appearance, outfit and colours (from the character sheets; never change them), props with their count where it matters and the scenes they appear in, and environments with the key features that must stay the same.

For every scene, in order:
- Split the clip into shots (usually 1 to 3 for a clip under 10 seconds) with start and end seconds that cover the clip. For each shot list who is on screen, where they stand (left/centre/right, foreground/background), which way they face, what they do and whether they speak; and every object that must be visible, with an exact count when the script counts or implies a number.
- Find contradictions between dialogue/narration and what the scene shows: looking or turning cues, things that are mentioned or pointed at but not described as visible, counts, left/right/up/down, who speaks vs who is on screen, actions described in dialogue that nobody performs, and appearance or prop changes compared with the bible and earlier scenes.
- Do not repeat purely stylistic preferences. If a scene is consistent, return no issues for it.
- promptAdditions: explicit visual requirements (one per line) the video model needs so the shots come out right: positions, gaze directions, exact counts, objects that must be in frame, fixed colours. Empty when the prompt already covers everything.

${ISSUE_RULES}

Write in English. Refer to scenes by their number.`;

type BibleCharacter = { name: string; visualDescription: string; references: number };

export function buildPreflightPrompt(input: {
  title: string;
  visualStyle: string;
  characters: BibleCharacter[];
  scenes: (QcScene & { referenceLabels: string[] })[];
}) {
  const cast = input.characters.length
    ? input.characters.map((c) => `- ${c.name}: ${c.visualDescription || "(no description)"}${c.references ? "" : " [no reference image]"}`).join("\n")
    : "(no linked characters)";
  const scenes = input.scenes
    .map((s) =>
      [
        `<scene number="${s.number}" seconds="${s.durationSeconds}">`,
        `Title: ${s.title}`,
        `Characters linked: ${s.characters.map((c) => c.name).join(", ") || "(none)"}`,
        `Setting: ${s.setting || "(none)"}`,
        `Action: ${s.action || "(none)"}`,
        `Narration: ${s.narration || "(none)"}`,
        `Dialogue:\n${s.dialogue.length ? s.dialogue.map((d) => `${d.character}: ${d.line}`).join("\n") : "(none)"}`,
        `Video prompt: ${s.visualPrompt || "(none)"}`,
        `Extra reference images: ${s.referenceLabels.join(", ") || "(none)"}`,
        "</scene>",
      ].join("\n"),
    )
    .join("\n\n");
  return {
    system: PREFLIGHT_SYSTEM_PROMPT,
    user: `Story: ${input.title}\nVisual style: ${input.visualStyle || "(not set)"}\n\n<character_sheets>\n${cast}\n</character_sheets>\n\n${scenes}\n\nCheck every scene and return the bible, shots, issues and prompt additions.`,
  };
}

export const VISION_SYSTEM_PROMPT = `You inspect AI-generated video clips for an original animated children's YouTube channel. You get frames extracted from one clip (each labelled with its timestamp), the character reference images, the scene's script and its shot list. Compare what is actually visible with what the story says should be visible.

Check, frame by frame:
- Gaze and movement: characters look, turn and point where the dialogue and action say (e.g. after "look behind you" someone must turn around).
- Every object or place the dialogue or narration talks about is visible when it's mentioned; counts match exactly (count the objects you can see).
- Left/right/up/down directions match.
- The speaking character is the one shown speaking (mouth open/animated); listeners don't appear to talk.
- Characters match their reference images: face, fur/hair, proportions, outfit and colours; props and environments match the continuity bible and stay the same from frame to frame (nothing appears, disappears or changes colour without a reason).
- Visual quality problems a child would notice: extra or missing limbs, melted faces, garbled text, sudden morphing.
- The thumbnail frame (the first frame given) is not black, blurry or mid-transition and shows the main character or subject.

Be concrete: say what you expected, what you observed, and the timestamp of the frame where you see it. You only see stills, so don't claim things about motion between frames or about the audio; when something can't be judged from the frames, don't report it as critical. Report only real mismatches; an empty issue list is a valid answer.

${ISSUE_RULES}

summary: one or two sentences. promptAdditions: explicit visual requirements (one per line) that would fix the critical issues on regeneration; empty when there are none. Write in English.`;

export function buildVisionText(input: {
  scene: QcScene;
  shots: ShotSpec[];
  bible: ContinuityBible | null;
  frameTimes: number[];
  referenceLabels: string[];
  isImage: boolean;
}) {
  const { scene } = input;
  const bible = input.bible
    ? [
        ...input.bible.characters.map((c) => `- ${c.name}: ${c.appearance}; outfit: ${c.outfit}; colours: ${c.colors.join(", ")}`),
        ...input.bible.props.filter((p) => p.scenes.includes(scene.number)).map((p) => `- Prop ${p.name}${p.count !== null ? ` (×${p.count})` : ""}: ${p.description}`),
        ...input.bible.environments.filter((e) => e.scenes.includes(scene.number)).map((e) => `- Place ${e.name}: ${e.description}; must show: ${e.keyFeatures.join(", ")}`),
      ].join("\n")
    : "(none yet)";
  return [
    input.isImage
      ? "This is a still keyframe for the scene (not a clip). Judge it against the first shot."
      : `Frames from a ${scene.durationSeconds}s clip, at ${input.frameTimes.map((t) => `${t}s`).join(", ")}. The first frame is the thumbnail candidate.`,
    `References attached: ${input.referenceLabels.join("; ") || "(none)"}`,
    `<scene number="${scene.number}">`,
    `Title: ${scene.title}`,
    `Characters: ${scene.characters.map((c) => `${c.name} (${c.visualDescription})`).join("; ") || "(none)"}`,
    `Setting: ${scene.setting || "(none)"}`,
    `Action: ${scene.action || "(none)"}`,
    `Narration: ${scene.narration || "(none)"}`,
    `Dialogue:\n${scene.dialogue.length ? scene.dialogue.map((d) => `${d.character}: ${d.line}`).join("\n") : "(none)"}`,
    `Video prompt: ${scene.visualPrompt || "(none)"}`,
    "</scene>",
    `<shots>\n${input.shots.length ? describeShots(input.shots) : "(no shot list: judge against the script)"}\n</shots>`,
    `<continuity_bible>\n${bible}\n</continuity_bible>`,
    "Compare the frames with the story and report mismatches.",
  ].join("\n");
}
