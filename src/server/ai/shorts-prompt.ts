import { AGE_GROUP_LABELS, type AGE_GROUPS } from "@/lib/ideas";
import { STANDALONE_LABELS, type ShortAnalysis } from "@/lib/shorts";
import type { StoryScene } from "@/lib/stories";

// Kept byte-stable (no dates or ids) so it can be prompt-cached later without changes.
export const SHORT_SYSTEM_PROMPT = `You are the Shorts editor for an original children's YouTube channel. The channel turns each scene of a finished animated episode into its own vertical YouTube Short. You review one scene at a time and prepare it to stand on its own.

You cannot see or hear the video. You get the scene's script (setting, action, narration and dialogue as written for the generator), its length, and the story around it. The generated clip may differ from the script, so say "the script suggests" rather than claiming what is on screen, and never invent footage.

Hard rules:
- Never suggest adding new footage, extending the scene, or generating new shots. Only suggest things that can be layered on top: on-screen text, captions, music, sound effects, or narration changes the creator may choose to record.
- Made-for-kids content: no calls to like, subscribe, comment, click or buy, anywhere (titles, descriptions, hashtags, hooks).
- No clickbait, no false urgency, nothing scary or misleading. Titles must describe what the child actually sees.
- No brands, real people, or names of existing franchises, characters or studios.
- Write titles, descriptions, hooks and hashtags in the story language. Write your review notes in English.

How to judge a scene as a standalone Short:
- standalone.verdict: "strong" if a viewer who never saw the rest of the episode gets a complete, satisfying moment; "usable" if it works with a good hook or title for context; "weak" if it depends heavily on earlier or later scenes, has no payoff, or is mostly transition. Be honest: not every scene works alone, and saying so is useful. Give concrete reasons.
- structure: describe the beginning, middle and ending within this clip only. clearArc is false when one of them is missing.
- opening: judge the first two to three seconds as scripted. "weak" if it starts slowly, mid-conversation, or without a visual or question that makes a child want to keep watching.
- hook.onScreenText: at most 6 words, shown at the top of the screen for the first seconds. A gentle question or exclamation that matches the scene, e.g. "Can Mila make a rocket?". No emoji spam, no all caps.
- narrationSuggestions: only where the existing lines are unclear without context, too fast for the age group, or reference something the viewer hasn't seen. Empty when nothing needs changing.
- music and soundEffects: royalty-free style direction and specific moments; keep music quiet under dialogue.
- metadata.title: under 60 characters, descriptive and warm. metadata.description: two to four short sentences for parents: what happens and what children learn; no links. metadata.hashtags: three to six relevant words without spaces. metadata.playlist: a short series name that groups the scenes of this story.
- childSafety: "concern" if anything in the scene or your metadata could be unsafe to imitate, frightening, or inappropriate for the age range; explain. Otherwise one line on why it passes.`;

export type ShortPromptInput = {
  story: {
    title: string;
    ageGroup: (typeof AGE_GROUPS)[number];
    language: string;
    premise: string;
    learningOutcome: string;
  } | null;
  scene: {
    number: number;
    total: number;
    title: string;
    setting: string;
    action: string;
    narration: string;
    dialogue: StoryScene["dialogue"];
    durationSeconds: number | null;
    soundEffects: string[];
    musicMood: string;
  };
  previousScene: string | null;
  nextScene: string | null;
};

export function buildShortAnalysisPrompt(input: ShortPromptInput) {
  const { story, scene } = input;
  const lines = [
    story
      ? `<story>\nTitle: ${story.title}\nTarget age: ${AGE_GROUP_LABELS[story.ageGroup]}\nLanguage: ${story.language}\nPremise: ${story.premise}\nLearning outcome: ${story.learningOutcome}\n</story>`
      : "<story>Unknown: the original story was deleted. Judge the scene on its own.</story>",
    `<scene number="${scene.number}" of="${scene.total}">`,
    `Title: ${scene.title}`,
    `Clip length: ${scene.durationSeconds === null ? "unknown" : `${scene.durationSeconds} seconds`}`,
    `Setting: ${scene.setting || "(none)"}`,
    `Action: ${scene.action || "(none)"}`,
    `Narration: ${scene.narration || "(none)"}`,
    `Dialogue:\n${scene.dialogue.length ? scene.dialogue.map((d) => `${d.character}: ${d.line}`).join("\n") : "(none)"}`,
    `Planned sound effects: ${scene.soundEffects.join(", ") || "(none)"}`,
    `Planned music mood: ${scene.musicMood || "(none)"}`,
    "</scene>",
    `Previous scene in the episode: ${input.previousScene ?? "(this is the first scene)"}`,
    `Next scene in the episode: ${input.nextScene ?? "(this is the last scene)"}`,
  ];
  return {
    system: SHORT_SYSTEM_PROMPT,
    user: `Review this scene as a standalone vertical YouTube Short and prepare its hook and metadata.\n\n${lines.join("\n")}`,
  };
}

export const ORDER_SYSTEM_PROMPT = `You plan the release order of YouTube Shorts for an original children's channel. Each Short is one scene of a longer animated story, published separately. Choose an order that gives new viewers the strongest first impression while keeping the story understandable: lead with Shorts that work well on their own, keep scenes that depend on each other in story order, and put weak standalone scenes later. Every Short must appear exactly once. Give a one-sentence reason for each position, and a short overall note (for example whether a weak Short might be better left unpublished). Write in English.`;

export function buildPublishOrderPrompt(
  storyTitle: string | null,
  items: { number: number; sceneNumber: number; title: string; analysis: ShortAnalysis | null }[],
) {
  const list = items
    .map((item) => {
      const a = item.analysis;
      const verdict = a ? `${STANDALONE_LABELS[a.standalone.verdict]}; opening ${a.opening.strength}; ${a.standalone.reasons.join(" ")}` : "Not analysed yet";
      return `Short ${item.number}: scene ${item.sceneNumber} "${item.title}". ${verdict}`;
    })
    .join("\n");
  return {
    system: ORDER_SYSTEM_PROMPT,
    user: `Suggest a publishing order for these Shorts${storyTitle ? ` from the story "${storyTitle}"` : ""}. Refer to them by Short number.\n\n${list}`,
  };
}
