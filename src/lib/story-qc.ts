import { z } from "zod";

import type { SceneFrames } from "./kling";
import type { CheckStatus } from "./short-qc";
import type { StoryScene } from "./stories";

// Story-to-video quality control, shared by the server (gates, prompts) and client components.
//
// Three stages:
//  1. Preflight, before money is spent: free text rules over the script (this file) plus an optional,
//     cached Claude pass that splits each scene into shots and builds a continuity bible.
//  2. Vision, after generation: Claude looks at frames extracted from the clip and compares them with
//     the shot list, dialogue and reference images. Stored on the asset (assets.metadata.qc).
//  3. Publish: Shorts and full videos can't be approved or uploaded with unresolved critical issues.

export const QC_SEVERITIES = ["critical", "warning", "info"] as const;
export type QcSeverity = (typeof QC_SEVERITIES)[number];

export const QC_CATEGORIES = [
  "gaze",
  "unseen_object",
  "quantity",
  "direction",
  "dialogue_action",
  "speaker",
  "appearance",
  "prop_continuity",
  "environment",
  "reference",
  "timing",
  "visual_quality",
  "other",
] as const;
export type QcCategory = (typeof QC_CATEGORIES)[number];

export const QC_CATEGORY_LABELS: Record<QcCategory, string> = {
  gaze: "Gaze / looking",
  unseen_object: "Mentioned but not shown",
  quantity: "Counts and quantities",
  direction: "Direction and pointing",
  dialogue_action: "Dialogue vs action",
  speaker: "Speakers",
  appearance: "Character appearance",
  prop_continuity: "Props across shots",
  environment: "Environment",
  reference: "Reference images",
  timing: "Timing",
  visual_quality: "Visual quality",
  other: "Other",
};

export type QcSource = "rules" | "ai" | "vision";

export type QcIssue = {
  /** Stable across runs, so a person can dismiss an issue and it stays dismissed. */
  id: string;
  source: QcSource;
  severity: QcSeverity;
  category: QcCategory;
  message: string;
  /** What to add to the prompt to prevent it: an imperative sentence. */
  fix: string;
  shot?: number | null;
  /** Seconds into the clip (vision issues only). */
  timestamp?: number | null;
  expected?: string;
  observed?: string;
};

// ---------- Shot list and continuity bible (Claude preflight output) ----------

const nullableNumber = z.number().nullable();

export const shotSpecSchema = z.object({
  number: z.number(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  description: z.string(),
  characters: z.array(
    z.object({
      name: z.string(),
      position: z.string(),
      facing: z.string(),
      action: z.string(),
      speaking: z.boolean(),
    }),
  ),
  objects: z.array(z.object({ name: z.string(), count: nullableNumber, position: z.string() })),
});
export type ShotSpec = z.infer<typeof shotSpecSchema>;

export const continuityBibleSchema = z.object({
  characters: z.array(
    z.object({ name: z.string(), appearance: z.string(), outfit: z.string(), colors: z.array(z.string()), carriedProps: z.array(z.string()) }),
  ),
  props: z.array(z.object({ name: z.string(), description: z.string(), count: nullableNumber, scenes: z.array(z.number()) })),
  environments: z.array(z.object({ name: z.string(), description: z.string(), keyFeatures: z.array(z.string()), scenes: z.array(z.number()) })),
});
export type ContinuityBible = z.infer<typeof continuityBibleSchema>;

const modelIssueSchema = z.object({
  severity: z.enum(QC_SEVERITIES),
  category: z.enum(QC_CATEGORIES),
  shot: nullableNumber,
  message: z.string(),
  fix: z.string(),
});

export const preflightResultSchema = z.object({
  bible: continuityBibleSchema,
  scenes: z.array(
    z.object({
      sceneNumber: z.number(),
      shots: z.array(shotSpecSchema),
      issues: z.array(modelIssueSchema),
      promptAdditions: z.string(),
    }),
  ),
});
export type PreflightResult = z.infer<typeof preflightResultSchema>;

export const visionResultSchema = z.object({
  frames: z.array(z.object({ time: z.number(), description: z.string() })),
  issues: z.array(
    modelIssueSchema.extend({ timestamp: nullableNumber, expected: z.string(), observed: z.string() }),
  ),
  thumbnail: z.object({ time: z.number(), ok: z.boolean(), note: z.string() }),
  summary: z.string(),
  promptAdditions: z.string(),
});
export type VisionResult = z.infer<typeof visionResultSchema>;

/** Stored in production_scenes.continuity. */
export type ScenePreflight = {
  specHash: string;
  checkedAt: string;
  model: string;
  shots: ShotSpec[];
  issues: QcIssue[];
  promptAdditions: string;
};

export type PromptRevision = { prompt: string; replacedAt: string; reason: string };

export type SceneContinuity = {
  /** Extra approved images (props, places, keyframes) sent as references alongside character references. */
  referenceAssetIds: string[];
  preflight: ScenePreflight | null;
  /** Issue ids a person reviewed and accepted. */
  dismissed: string[];
  /** Claude issue ids whose fix was written into the visual prompt by an automatic correction. */
  corrected?: string[];
  /** Earlier visual prompts, newest first, so automatic corrections can be undone. */
  promptHistory: PromptRevision[];
  /** Middle and end keyframes for Kling 4.0 clips; see readSceneFrames in ./kling. */
  frames?: SceneFrames;
};

export const EMPTY_SCENE_CONTINUITY: SceneContinuity = { referenceAssetIds: [], preflight: null, dismissed: [], promptHistory: [] };

export function readSceneContinuity(value: Partial<SceneContinuity> | null | undefined): SceneContinuity {
  return { ...EMPTY_SCENE_CONTINUITY, ...(value ?? {}) };
}

/** Stored in production_plans.continuity. */
export type PlanContinuity = { bible: ContinuityBible; checkedAt: string; model: string };

/** Stored in assets.metadata.qc. */
export type VisionReport = {
  specHash: string;
  checkedAt: string;
  model: string;
  frames: { time: number; description: string }[];
  issues: QcIssue[];
  thumbnail: { time: number; ok: boolean; note: string };
  summary: string;
  promptAdditions: string;
};

export function readVisionReport(metadata: Record<string, unknown> | null | undefined): VisionReport | null {
  const qc = metadata?.qc as VisionReport | undefined;
  return qc && Array.isArray(qc.issues) && typeof qc.specHash === "string" ? qc : null;
}

// ---------- Scene input ----------

export type QcCharacter = { name: string; visualDescription: string; hasReference: boolean };

export type QcScene = {
  id: string;
  number: number;
  title: string;
  setting: string;
  action: string;
  narration: string;
  dialogue: StoryScene["dialogue"];
  visualPrompt: string;
  durationSeconds: number;
  characters: QcCharacter[];
};

/**
 * The script fields the checks read, picked from a production scene. Nothing else on the scene
 * (notes, text overlays added in post) reaches a QC prompt.
 */
export function toQcScene(
  scene: Omit<QcScene, "number" | "characters">,
  number: number,
  characters: QcCharacter[],
): QcScene {
  return {
    id: scene.id,
    number,
    title: scene.title,
    setting: scene.setting,
    action: scene.action,
    narration: scene.narration,
    dialogue: scene.dialogue,
    visualPrompt: scene.visualPrompt,
    durationSeconds: scene.durationSeconds,
    characters,
  };
}

/** FNV-1a: small, synchronous, and the same in the browser and on the server. */
export function hashText(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Changes whenever anything the checks read changes, so stale results are never trusted. */
export function sceneSpecHash(scene: Omit<QcScene, "id" | "number" | "title">) {
  return hashText(
    JSON.stringify([
      scene.setting.trim(),
      scene.action.trim(),
      scene.narration.trim(),
      scene.dialogue.map((d) => [d.character.trim(), d.line.trim()]),
      stripCorrections(scene.visualPrompt).trim(),
      scene.durationSeconds,
      scene.characters.map((c) => [c.name, c.visualDescription.trim()]).sort(),
    ]),
  );
}

function issue(source: QcSource, severity: QcSeverity, category: QcCategory, message: string, fix: string, extra: Partial<QcIssue> = {}): QcIssue {
  return { id: `${source}:${category}:${hashText(message.toLowerCase())}`, source, severity, category, message, fix, ...extra };
}

/** Gives model-reported issues stable ids. */
export function toQcIssues(
  source: Exclude<QcSource, "rules">,
  items: { severity: QcSeverity; category: QcCategory; shot: number | null; message: string; fix: string; timestamp?: number | null; expected?: string; observed?: string }[],
) {
  return items
    .filter((i) => i.message.trim())
    .map((i) =>
      issue(source, i.severity, i.category, i.message.trim(), i.fix.trim(), {
        shot: i.shot,
        timestamp: i.timestamp ?? null,
        expected: i.expected?.trim() || undefined,
        observed: i.observed?.trim() || undefined,
      }),
    );
}

// ---------- Text helpers ----------

const NARRATOR = "narrator";

const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

// Plural nouns that follow a number but aren't countable things on screen.
const NON_OBJECTS = new Set([
  "seconds", "minutes", "hours", "days", "weeks", "months", "years", "times", "ways", "steps", "turns",
  "more", "of", "and", "or", "words", "letters", "colors", "colours", "tries", "goes", "kinds", "sorts",
]);

// Things that are a scene element when named in dialogue: if a character talks about them, viewers expect to see them.
const LANDMARKS = [
  "lake", "river", "pond", "sea", "ocean", "beach", "waterfall", "stream", "mountain", "hill", "volcano", "cave",
  "forest", "tree", "bush", "flower", "garden", "meadow", "field", "island", "castle", "tower", "house", "barn",
  "bridge", "boat", "ship", "train", "car", "bus", "plane", "rocket", "balloon", "kite", "ball", "door", "window",
  "rainbow", "moon", "sun", "star", "cloud", "nest", "egg", "fish", "duck", "bird", "frog", "butterfly", "bee",
  "puppy", "kitten", "cat", "dog", "rabbit", "bunny", "owl", "fox", "bear", "apple", "banana", "carrot", "cake",
  "cookie", "basket", "box", "map", "treasure", "key", "book", "lamp", "fire", "campfire", "tent", "swing", "slide",
  "sandcastle", "shell", "rock", "puddle", "snowman", "path", "fence", "gate", "well", "playground", "school",
];

// Abstract words after "the" that never need to be on screen.
const NOT_VISIBLE = new Set([
  "way", "end", "time", "moment", "idea", "answer", "rest", "same", "first", "last", "best", "one", "ones", "thing",
  "things", "world", "morning", "evening", "night", "day", "story", "game", "song", "problem", "question", "sound",
  "noise", "plan", "secret", "matter", "difference", "reason", "truth", "magic", "wind", "air", "light",
]);

const COLORS = [
  "red", "orange", "yellow", "green", "blue", "purple", "violet", "pink", "brown", "black", "white", "grey", "gray",
  "golden", "gold", "silver", "teal", "turquoise", "navy", "beige", "cream", "crimson", "lilac", "lavender", "mint",
];
const GARMENTS = [
  "dress", "shirt", "t-shirt", "hat", "cap", "beanie", "scarf", "jacket", "coat", "raincoat", "boots", "shoes",
  "sneakers", "overalls", "dungarees", "sweater", "jumper", "hoodie", "skirt", "trousers", "pants", "shorts",
  "backpack", "bow", "ribbon", "glasses", "vest", "cape", "gloves", "mittens", "socks", "hair", "fur", "eyes",
  "bandana", "apron", "helmet", "tie", "collar", "umbrella",
];

const COLOR_NORMAL: Record<string, string> = { gray: "grey", gold: "golden", violet: "purple" };

function words(text: string) {
  return text.toLowerCase().replace(/[’']/g, "'");
}

function stem(noun: string) {
  const n = noun.toLowerCase();
  if (n.endsWith("ies") && n.length > 4) return `${n.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses|oes)$/.test(n)) return n.slice(0, -2);
  if (n.endsWith("s") && !n.endsWith("ss") && n.length > 3) return n.slice(0, -1);
  return n;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(text: string, noun: string) {
  const s = escapeRegExp(stem(noun));
  return new RegExp(`\\b${s}(s|es)?\\b`).test(text) || new RegExp(`\\b${escapeRegExp(noun)}\\b`).test(text);
}

function spokenText(scene: Pick<QcScene, "dialogue" | "narration">) {
  return words([scene.narration, ...scene.dialogue.map((d) => d.line)].join(" \n "));
}

/** What the generator is told to show: setting, action and the visual prompt. */
function shownText(scene: Pick<QcScene, "setting" | "action" | "visualPrompt">) {
  return words([scene.setting, scene.action, scene.visualPrompt].join(" \n "));
}

function parseCount(token: string) {
  return /^\d+$/.test(token) ? Number(token) : (NUMBER_WORDS[token] ?? null);
}

const COUNT_TOKEN = `(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})`;

/** "three red apples" -> [{ count: 3, noun: "apple" }]. Only plurals, so "one day" is never a count. */
export function extractCounts(text: string) {
  const out: { count: number; noun: string }[] = [];
  const re = new RegExp(`\\b${COUNT_TOKEN}\\s+(?:(?:little|big|small|tiny|shiny|[a-z]+-?[a-z]*)\\s+)?([a-z]{3,}s)\\b`, "g");
  for (const m of words(text).matchAll(re)) {
    const count = parseCount(m[1]);
    // The optional adjective can swallow the noun ("three apples"), so retry without it.
    let noun = m[2];
    const direct = new RegExp(`\\b${escapeRegExp(m[1])}\\s+([a-z]{3,}s)\\b`).exec(m[0]);
    if (direct) noun = direct[1];
    if (count === null || NON_OBJECTS.has(noun)) continue;
    if (!out.some((o) => o.noun === stem(noun) && o.count === count)) out.push({ count, noun: stem(noun) });
  }
  return out;
}

type Direction = "left" | "right" | "up" | "down" | "behind";
const OPPOSITE: Record<Direction, Direction | null> = { left: "right", right: "left", up: "down", down: "up", behind: null };

function extractDirections(text: string) {
  const t = words(text);
  const found = new Set<Direction>();
  if (/\b(on|to|at|towards?) (your|my|the|his|her|their|our) left\b|\bleft side\b|\b(points?|pointing|turns?|looks?|looking|walks?|goes|runs?) (to the )?left\b/.test(t)) found.add("left");
  if (/\b(on|to|at|towards?) (your|my|the|his|her|their|our) right\b|\bright side\b|\b(points?|pointing|turns?|looks?|looking|walks?|goes|runs?) (to the )?right\b/.test(t)) found.add("right");
  if (/\b(look|looks|looking|point|points|pointing|up) up\b|\bup (there|high|in the sky)\b|\blooks? upward/.test(t)) found.add("up");
  if (/\b(look|looks|looking|point|points|pointing) down\b|\bdown (there|below)\b|\blooks? downward/.test(t)) found.add("down");
  if (/\bbehind (you|me|us|them|him|her)\b|\blook(s|ing)? behind\b|\bturns? around\b|\blooks? back\b|\bover (his|her|their|your) shoulder\b/.test(t)) found.add("behind");
  return found;
}

/** The (colour, garment) pairs a text gives a character, e.g. "a red raincoat" -> red/raincoat. */
export function extractWardrobe(text: string) {
  const pairs = new Map<string, string>();
  const re = new RegExp(`\\b(${COLORS.join("|")})(?:[\\s-]+[a-z]+){0,2}?[\\s-]+(${GARMENTS.map(escapeRegExp).join("|")})\\b`, "g");
  for (const m of words(text).matchAll(re)) {
    const garment = m[2];
    if (!pairs.has(garment)) pairs.set(garment, COLOR_NORMAL[m[1]] ?? m[1]);
  }
  return pairs;
}

/** Sentences of `text` that mention `name`. */
function sentencesAbout(text: string, name: string) {
  const n = name.toLowerCase().trim();
  if (!n) return "";
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => s.toLowerCase().includes(n))
    .join(" ");
}

/** Objects that dialogue asks the viewer to look at: "look at the lake", "see those ducks?", "there's a boat". */
function lookedAtObjects(spoken: string) {
  const out = new Set<string>();
  const re =
    /\b(?:look(?:ing)? at|look,|see|seen|watch|there'?s|there is|there are|here'?s|here is|over there,? (?:by|at|near|in)|this is|that'?s)\s+(?:the|that|this|those|these|a|an|our|my|your|his|her|its|their)\s+(?:(?:big|little|small|tiny|huge|giant|shiny|old|new|tall|blue|red|green|yellow|pink|purple|orange|white|black|brown|golden|sparkly|beautiful|pretty|funny)\s+)?([a-z]{3,})/g;
  for (const m of spoken.matchAll(re)) {
    const noun = m[1];
    if (!NOT_VISIBLE.has(noun) && !NOT_VISIBLE.has(stem(noun))) out.add(noun);
  }
  return out;
}

// ---------- Rule-based preflight ----------

/** Free, instant checks for one scene. `earlier` are the scenes before it, for continuity. */
export function checkSceneRules(scene: QcScene, earlier: QcScene[] = []): QcIssue[] {
  const issues: QcIssue[] = [];
  const spoken = spokenText(scene);
  const shown = shownText(scene);
  const add = (severity: QcSeverity, category: QcCategory, message: string, fix: string) =>
    issues.push(issue("rules", severity, category, message, fix));
  const castNames = scene.characters.map((c) => c.name.trim()).filter(Boolean);
  const listener = castNames.length ? castNames.join(" and ") : "the characters";

  if (!scene.visualPrompt.trim()) {
    add("critical", "other", "The scene has no visual prompt, so nothing tells the generator what to show.", "Write a visual prompt for the scene.");
  }

  // Gaze and direction: what the dialogue tells someone to look at must be what they do on screen.
  const said = extractDirections(spoken);
  const done = extractDirections(shown);
  for (const dir of said) {
    if (done.has(dir)) continue;
    const opposite = OPPOSITE[dir];
    if (opposite && done.has(opposite)) {
      add(
        "critical",
        "direction",
        `The dialogue says "${dir}" but the action/prompt shows "${opposite}".`,
        `Make the movement and gaze go ${dir}, matching the dialogue.`,
      );
    } else if (dir === "behind") {
      add(
        "critical",
        "gaze",
        `Someone is told to look behind them, but the action/prompt never has ${listener} turn around.`,
        `${listener} turn around and look behind them, so the viewer sees what is behind them.`,
      );
    } else {
      add(
        "warning",
        "direction",
        `The dialogue says "${dir}" but the action/prompt doesn't say which way anyone looks or points; video models often get this backwards.`,
        `State the direction explicitly: characters look and point ${dir === "up" || dir === "down" ? dir + "wards" : `to the ${dir} of the frame`}.`,
      );
    }
  }

  // Objects the viewer is asked to look at must be in the picture.
  const lookedAt = lookedAtObjects(spoken);
  for (const noun of lookedAt) {
    if (mentions(shown, noun)) continue;
    add(
      "critical",
      "unseen_object",
      `The dialogue points to "${noun}", but it isn't in the setting, action or visual prompt.`,
      `Show the ${noun} clearly in frame while it is talked about.`,
    );
  }
  // Scenery named in passing is probably expected on screen too.
  for (const noun of LANDMARKS) {
    if (lookedAt.has(noun) || !mentions(spoken, noun) || mentions(shown, noun)) continue;
    if ([...lookedAt].some((l) => stem(l) === stem(noun))) continue;
    add(
      "warning",
      "unseen_object",
      `The dialogue mentions "${noun}", which isn't described in the visual prompt. If viewers should see it, add it.`,
      `Show the ${noun} in the scene.`,
    );
  }

  // Quantities: a counted object must be generated in exactly that number.
  const shownCounts = extractCounts(shown);
  for (const { count, noun } of extractCounts(`${spoken}\n${words(scene.action)}`)) {
    const inPrompt = shownCounts.filter((c) => c.noun === noun);
    if (inPrompt.some((c) => c.count === count)) continue;
    if (inPrompt.length) {
      add(
        "critical",
        "quantity",
        `The script has ${count} ${noun}s but the prompt shows ${inPrompt.map((c) => c.count).join(" or ")}.`,
        `Show exactly ${count} ${noun}s, clearly separated so they can be counted.`,
      );
    } else {
      add(
        "critical",
        "quantity",
        `The script counts ${count} ${noun}s but the visual prompt doesn't fix how many to show.`,
        `Show exactly ${count} ${noun}s, clearly separated so they can be counted.`,
      );
    }
  }
  if (/\b(one|1)[,.!\s]+(two|2)[,.!\s]+(three|3)\b/.test(spoken) && !shownCounts.length && !extractCounts(spoken).length) {
    add(
      "warning",
      "quantity",
      "Someone counts out loud, but the prompt doesn't say how many objects are on screen.",
      "State exactly how many objects are shown, matching the counting.",
    );
  }

  // Pointing needs a target.
  if (/\bpoint(s|ing|ed)?\b/.test(shown) && !/\bpoint(s|ing|ed)? (at|to|towards?|up|down|left|right)\b/.test(shown)) {
    add("warning", "direction", "A character points, but the prompt doesn't say at what.", "Say exactly what the character points at and in which direction.");
  }

  // Speakers must be on screen (or the narrator).
  const cast = new Set(castNames.map((n) => n.toLowerCase()));
  const missingSpeakers = [
    ...new Set(
      scene.dialogue
        .map((d) => d.character.trim())
        .filter((n) => n && n.toLowerCase() !== NARRATOR && !cast.has(n.toLowerCase())),
    ),
  ];
  for (const name of missingSpeakers) {
    add(
      "critical",
      "speaker",
      `${name} speaks but isn't linked to the scene, so the generator gets no description or reference of them.`,
      `Show ${name} in the scene.`,
    );
  }

  // Reference images keep faces and outfits consistent.
  for (const c of scene.characters) {
    if (!c.hasReference) {
      add(
        "warning",
        "reference",
        `${c.name} has no approved reference image; their look may drift between scenes.`,
        `Keep ${c.name}'s look exactly as described.`,
      );
    }
  }

  // Wardrobe and colours must match the character bible and earlier scenes.
  for (const c of scene.characters) {
    const canonical = extractWardrobe(c.visualDescription);
    const here = extractWardrobe(sentencesAbout(`${scene.visualPrompt}\n${scene.action}`, c.name));
    for (const [garment, color] of here) {
      const expected = canonical.get(garment);
      if (expected && expected !== color) {
        add(
          "critical",
          "appearance",
          `${c.name} wears a ${color} ${garment} here, but their character sheet says ${expected}.`,
          `${c.name}'s ${garment} is ${expected}.`,
        );
        continue;
      }
      if (expected) continue;
      for (const prev of earlier) {
        const before = extractWardrobe(sentencesAbout(`${prev.visualPrompt}\n${prev.action}`, c.name)).get(garment);
        if (before && before !== color) {
          add(
            "critical",
            "appearance",
            `${c.name}'s ${garment} is ${color} here but ${before} in scene ${prev.number}.`,
            `${c.name}'s ${garment} is ${before}, as in scene ${prev.number}.`,
          );
          break;
        }
      }
    }
  }

  // Quantities that change between scenes without a reason.
  const nowCounts = extractCounts(`${shown}\n${spoken}`);
  for (const { count, noun } of nowCounts) {
    for (const prev of [...earlier].reverse()) {
      const before = extractCounts(`${shownText(prev)}\n${spokenText(prev)}`).find((c) => c.noun === noun);
      if (!before) continue;
      if (before.count !== count && !/\b(eat|eats|ate|give|gives|gave|drop|drops|dropped|lose|loses|lost|took|takes|take|add|adds|added|find|finds|found|pick|picks|picked|share|shares|shared|more|another|plants?|grow|grows|grew)\b/.test(words(scene.action))) {
        add(
          "warning",
          "prop_continuity",
          `There are ${count} ${noun}s here but ${before.count} in scene ${prev.number}, and the action doesn't explain the change.`,
          `Show ${count} ${noun}s, or explain in the action why the number changed.`,
        );
      }
      break;
    }
  }

  // Lines must fit in the clip. Children's voices run about 2.5 words a second.
  const lineWords = spoken.split(/\s+/).filter(Boolean).length;
  if (scene.durationSeconds > 0 && lineWords / scene.durationSeconds > 3) {
    add(
      lineWords / scene.durationSeconds > 4 ? "critical" : "warning",
      "timing",
      `${lineWords} words of dialogue and narration in ${scene.durationSeconds}s is too fast to speak and lip-sync.`,
      "Keep the spoken lines short enough to say slowly in the clip.",
    );
  }

  return issues;
}

/** Rule checks for every scene of a plan, in order, keyed by scene id. */
export function checkPlanRules(scenes: QcScene[]) {
  const result = new Map<string, QcIssue[]>();
  scenes.forEach((scene, i) => result.set(scene.id, checkSceneRules(scene, scenes.slice(0, i))));
  return result;
}

// ---------- Combining stages ----------

export type SceneQcState = {
  specHash: string;
  /** Rule issues plus the Claude preflight's, when it was run on the current script. */
  issues: QcIssue[];
  preflightCurrent: boolean;
  preflightStale: boolean;
  dismissed: Set<string>;
};

export function sceneQcState(scene: QcScene, rules: QcIssue[], continuity: SceneContinuity): SceneQcState {
  const specHash = sceneSpecHash(scene);
  const pf = continuity.preflight;
  const current = Boolean(pf && pf.specHash === specHash);
  return {
    specHash,
    issues: [...rules, ...(current ? pf!.issues : [])],
    preflightCurrent: current,
    preflightStale: Boolean(pf && !current),
    dismissed: new Set(continuity.dismissed),
  };
}

export function openIssues(issues: QcIssue[], dismissed: Iterable<string>) {
  const skip = new Set(dismissed);
  return issues.filter((i) => !skip.has(i.id));
}

export function criticalIssues(issues: QcIssue[], dismissed: Iterable<string>) {
  return openIssues(issues, dismissed).filter((i) => i.severity === "critical");
}

export type VisionStatus = "unchecked" | "stale" | "pass" | "warn" | "fail";

/** A vision report only counts for the script it was checked against. */
export function visionStatus(report: VisionReport | null, specHash: string | null, dismissed: Iterable<string> = []): VisionStatus {
  if (!report) return "unchecked";
  if (specHash && report.specHash !== specHash) return "stale";
  const open = openIssues(report.issues, dismissed);
  if (open.some((i) => i.severity === "critical")) return "fail";
  if (open.some((i) => i.severity === "warning") || !report.thumbnail.ok) return "warn";
  return "pass";
}

export const VISION_STATUS_LABELS: Record<VisionStatus, string> = {
  unchecked: "Not inspected",
  stale: "Script changed since inspection",
  pass: "Matches the story",
  warn: "Minor mismatches",
  fail: "Mismatches the story",
};

/**
 * The "story consistency" check for the publish stage: preflight criticals (from the current script)
 * and the clip's vision report. Fails on unresolved critical issues; warns when not inspected.
 */
export function consistencyCheck(input: {
  sceneLabel: string;
  preflightCritical: QcIssue[];
  vision: VisionReport | null;
  visionStatus: VisionStatus;
  dismissed: Iterable<string>;
}): { status: CheckStatus; details: string[] } {
  const details: string[] = [];
  let status: CheckStatus = "pass";
  if (input.preflightCritical.length) {
    status = "fail";
    details.push(...input.preflightCritical.slice(0, 3).map((i) => `${input.sceneLabel} script: ${i.message}`));
  }
  const visionCritical = input.vision ? criticalIssues(input.vision.issues, input.dismissed) : [];
  switch (input.visionStatus) {
    case "fail":
      status = "fail";
      details.push(
        ...visionCritical.slice(0, 3).map((i) => `${input.sceneLabel}${i.timestamp != null ? ` at ${formatSeconds(i.timestamp)}` : ""}: ${i.message}`),
      );
      break;
    case "warn":
      if (status === "pass") status = "warn";
      details.push(`${input.sceneLabel}: minor mismatches found by the vision check. Review them.`);
      break;
    case "stale":
    case "unchecked":
      if (status === "pass") status = "warn";
      details.push(
        input.visionStatus === "stale"
          ? `${input.sceneLabel}: the script changed after the clip was inspected. Inspect it again.`
          : `${input.sceneLabel}: the clip hasn't been compared with the story by the vision check.`,
      );
      break;
    case "pass":
      details.push(`${input.sceneLabel}: the clip matches the story, dialogue and references.`);
  }
  if (input.vision && !input.vision.thumbnail.ok) details.push(`Thumbnail frame: ${input.vision.thumbnail.note}`);
  return { status, details };
}

export function formatSeconds(seconds: number) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${rest}`;
}

// ---------- Automatic prompt correction ----------

export const CORRECTIONS_HEADING = "Continuity requirements:";

/** The visual prompt without an earlier corrections block, so corrections never stack up. */
export function stripCorrections(prompt: string) {
  const at = prompt.indexOf(CORRECTIONS_HEADING);
  return at === -1 ? prompt : prompt.slice(0, at).trimEnd();
}

/**
 * Turns open issues (and Claude's own suggestions) into explicit visual requirements appended to the
 * visual prompt. Returns null when there is nothing to add.
 */
export function buildCorrectedPrompt(visualPrompt: string, issues: QcIssue[], additions: string[] = []) {
  const lines = [
    ...new Set(
      [...issues.filter((i) => i.severity !== "info").map((i) => i.fix), ...additions.flatMap((a) => a.split(/\n+/))]
        .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
        .filter(Boolean)
        .map((l) => (/[.!?]$/.test(l) ? l : `${l}.`)),
    ),
  ];
  if (!lines.length) return null;
  return `${stripCorrections(visualPrompt).trim()}\n\n${CORRECTIONS_HEADING}\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ---------- Prompt context for later stages ----------

/** Shot list as plain text for the generator and the vision check. */
export function describeShots(shots: ShotSpec[]) {
  return shots
    .map((s) => {
      const who = s.characters.map((c) => `${c.name} (${c.position}, facing ${c.facing}${c.speaking ? ", speaking" : ""}): ${c.action}`).join("; ");
      const what = s.objects.map((o) => `${o.count !== null ? `${o.count} ` : ""}${o.name} (${o.position})`).join(", ");
      return `Shot ${s.number} [${s.startSeconds}-${s.endSeconds}s]: ${s.description}${who ? ` | Characters: ${who}` : ""}${what ? ` | Objects: ${what}` : ""}`;
    })
    .join("\n");
}

/** Frame times for the vision check: the middle of every shot, plus the first second for the thumbnail. */
export function pickFrameTimes(durationSeconds: number, shots: ShotSpec[] = [], max = 8) {
  const d = Math.max(0.5, durationSeconds);
  const clampT = (t: number) => Math.round(Math.min(d - 0.1, Math.max(0, t)) * 10) / 10;
  const even = Math.min(max - 1, Math.max(3, Math.ceil(d / 2)));
  let times = shots.length
    ? shots.map((s) => clampT((Math.max(0, s.startSeconds) + Math.min(d, s.endSeconds || d)) / 2))
    : Array.from({ length: even }, (_, i) => clampT(((i + 0.5) * d) / even));
  times = [clampT(0.5), ...times];
  const unique = [...new Set(times)].sort((a, b) => a - b);
  if (unique.length <= max) return unique;
  // Keep an even spread when there are more shots than frames.
  return Array.from({ length: max }, (_, i) => unique[Math.round((i * (unique.length - 1)) / (max - 1))]);
}
