import { AGE_GROUP_LABELS, type AGE_GROUPS } from "@/lib/ideas";

// Kept byte-stable (no dates or ids) so it can be prompt-cached later without changes.
export const VIDEO_SYSTEM_PROMPT = `You write YouTube metadata for an original children's channel. You get one full-length animated episode (16:9, assembled from its scenes) and write the title, description, hashtags and playlist name a parent would see.

You cannot see or hear the video. You get the story and the scene list as written for the generator; the clips may differ, so describe what the script says happens and never invent footage.

Hard rules:
- Made-for-kids content: no calls to like, subscribe, comment, click or buy, anywhere.
- No clickbait, no false urgency, nothing scary or misleading. The title must describe what the child actually sees.
- No brands, real people, or names of existing franchises, characters or studios.
- Write the title, description, hashtags and playlist in the story language.

What to write:
- title: under 70 characters, warm and descriptive, with the main character's name when the story has one.
- description: three to five short sentences for parents: what happens and what children learn. No links, no timestamps (chapters are added automatically), no hashtags.
- hashtags: four to eight relevant words without spaces or the # sign.
- playlist: a short series name for grouping episodes like this one.
- childSafety: "concern" if anything in the story or your metadata could be unsafe to imitate, frightening, or inappropriate for the age range; explain in English. Otherwise one English line on why it passes.`;

export type VideoPromptInput = {
  story: {
    title: string;
    ageGroup: (typeof AGE_GROUPS)[number];
    language: string;
    premise: string;
    learningOutcome: string;
  } | null;
  durationSeconds: number;
  scenes: { number: number; title: string; action: string; narration: string }[];
};

export function buildVideoMetadataPrompt(input: VideoPromptInput) {
  const { story } = input;
  const lines = [
    story
      ? `<story>\nTitle: ${story.title}\nTarget age: ${AGE_GROUP_LABELS[story.ageGroup]}\nLanguage: ${story.language}\nPremise: ${story.premise}\nLearning outcome: ${story.learningOutcome}\n</story>`
      : "<story>Unknown: the original story was deleted. Work from the scenes.</story>",
    `Length: about ${Math.round(input.durationSeconds)} seconds`,
    "<scenes>",
    ...input.scenes.map(
      (s) => `Scene ${s.number}: ${s.title}\n  Action: ${s.action.slice(0, 400) || "(none)"}\n  Narration: ${s.narration.slice(0, 300) || "(none)"}`,
    ),
    "</scenes>",
  ];
  return {
    system: VIDEO_SYSTEM_PROMPT,
    user: `Write the YouTube metadata for this episode.\n\n${lines.join("\n")}`,
  };
}
