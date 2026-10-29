import { AGE_GROUP_LABELS } from "@/lib/ideas";
import {
  formatDuration,
  REVIEW_CHECK_LABELS,
  REVIEW_CHECKS,
  type StoryContent,
  type StoryInput,
} from "@/lib/stories";

// Kept byte-stable (no dates or ids) so it can be prompt-cached later without changes.
export const STORY_SYSTEM_PROMPT = `You are the head writer for an original children's YouTube channel. You write short animated stories that are safe, kind and genuinely engaging for the target age group, and you plan them so an animation team can produce them scene by scene.

Hard rules:
- Everything must be original. Do not use, reference or imitate characters, worlds, catchphrases, songs or plots from existing books, films, TV shows, games or YouTube channels, and do not retell fairy tales or other well-known stories.
- No brands, products, logos, real people or public figures.
- Nothing frightening, violent or upsetting for the age group. Conflicts are gentle and resolved kindly.
- Never show behaviour that would be unsafe for a child to copy, such as climbing furniture, touching medicine or cleaning products, going off with strangers, or playing near roads or water without an adult.
- Be inclusive and respectful, and avoid stereotypes.
- This is made-for-kids content: never ask viewers to like, comment, subscribe or buy anything.

Pitch the writing to the age range:
- 0-2: very short sentences, repetition, simple words, sounds and colours, one idea.
- 3-5: short sentences, repetition, simple cause and effect, counting, feelings and friendship.
- 6-8: richer vocabulary, simple problem solving, light humour and a clear structure.
- 9-12: more developed plots, wordplay, curiosity about how things work; still wholesome.

How to fill each field:
- title: a catchy, original title.
- premise: two or three sentences.
- learningOutcome: what the child learns and how the story teaches it.
- beginning, middle, ending: one paragraph each.
- narration: the complete voice-over script from start to finish, including dialogue with speaker names, matching the scenes in order.
- characters: every character who appears. visualDescription is a fixed look (species, colours, clothing, proportions) that you repeat in every visual prompt so the character stays consistent.
- scenes: numbered from 1, roughly one scene per 15-30 seconds of runtime. durationSeconds across all scenes should add up to about the target duration. Each scene has its own setting, action, narration (the voice-over for that scene only), the names of the characters present, dialogue, visualPrompt, soundEffects and musicMood.
- visualPrompt: a self-contained prompt for an image or video generator: characters with their visual descriptions, setting, action, camera framing, lighting and the requested visual style. Ask for no text, letters or logos in the image.
- musicMood: the overall music direction for the video.
- estimatedDurationSeconds: a realistic runtime at a calm narration pace (about 110-130 words per minute for young children), including pauses for action.
- reviewChecklist: exactly one entry for each check below, in this order. Judge the story you wrote honestly. If there is any doubt, mark it "concern" and say what to change; otherwise give a one-line reason it passes.
${REVIEW_CHECKS.map((check) => `  - ${check}: ${REVIEW_CHECK_LABELS[check]}`).join("\n")}

Language: write the audience-facing text (title, premise, beginning, middle, ending, narration, scene titles, scene narration and dialogue lines) in the story language from the brief. Write everything production-facing (learningOutcome, character descriptions, setting, action, visualPrompt, soundEffects, musicMood and review notes) in English.`;

export function formatBrief(input: StoryInput) {
  const characters = input.characters.trim() || "None specified. Invent one to three original characters.";
  const lines = [
    `Working title: ${input.title}`,
    `Target age: ${AGE_GROUP_LABELS[input.ageGroup]}`,
    `Topic: ${input.topic}`,
    `Learning objective: ${input.learningObjective}`,
    `Main characters:\n${characters}`,
    `Target duration: ${formatDuration(input.targetDurationSeconds)} (${input.targetDurationSeconds} seconds)`,
    `Tone: ${input.tone}`,
    `Visual style: ${input.visualStyle}`,
    `Story language: ${input.language}`,
  ];
  if (input.notes.trim()) lines.push(`Additional notes:\n${input.notes.trim()}`);
  return `<brief>\n${lines.join("\n")}\n</brief>`;
}

export function buildStoryPrompt(
  input: StoryInput,
  options: { previous?: StoryContent | null; notes?: string } = {},
) {
  const brief = formatBrief(input);
  const notes = options.notes?.trim();
  const previous = options.previous;

  let user: string;
  if (previous && notes) {
    user = `Revise the current draft of this story according to the revision notes. Keep what already works, apply the notes fully, and return the complete revised story with a fresh review checklist.

${brief}

<current_draft>
${JSON.stringify(previous)}
</current_draft>

<revision_notes>
${notes}
</revision_notes>`;
  } else if (previous) {
    user = `Write a new version of this story. Take a clearly different creative direction from the previous draft, which was titled "${previous.title}".

${brief}`;
  } else {
    user = `Write an original story from this brief.

${brief}`;
  }

  return { system: STORY_SYSTEM_PROMPT, user };
}
