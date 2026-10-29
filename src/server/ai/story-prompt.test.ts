import { describe, expect, it } from "vitest";

import { REVIEW_CHECKS } from "@/lib/stories";
import { sampleContent, sampleInput } from "@/test/fixtures";

import { buildStoryPrompt, STORY_SYSTEM_PROMPT } from "./story-prompt";

describe("buildStoryPrompt", () => {
  it("puts every brief field in the user message", () => {
    const { system, user } = buildStoryPrompt(sampleInput);
    expect(system).toBe(STORY_SYSTEM_PROMPT);
    for (const text of [
      "Pip and the Puddle Count",
      "Preschool (3–5)",
      "A duckling counts puddles",
      "Count from one to five",
      "Pip – a small yellow duckling",
      "2 min (120 seconds)",
      "Playful and silly",
      "Soft 3D animation",
      "Story language: English",
    ]) {
      expect(user).toContain(text);
    }
    expect(user).toContain("Write an original story");
  });

  it("asks Claude to invent characters when none are given", () => {
    expect(buildStoryPrompt({ ...sampleInput, characters: " " }).user).toContain(
      "Invent one to three original characters",
    );
  });

  it("includes the current draft and notes when revising", () => {
    const { user } = buildStoryPrompt(sampleInput, { previous: sampleContent, notes: "Make it shorter" });
    expect(user).toContain("<current_draft>");
    expect(user).toContain(sampleContent.premise);
    expect(user).toContain("<revision_notes>\nMake it shorter");
  });

  it("asks for a different direction when regenerating without notes", () => {
    const { user } = buildStoryPrompt(sampleInput, { previous: sampleContent, notes: "  " });
    expect(user).toContain(`previous draft, which was titled "${sampleContent.title}"`);
    expect(user).not.toContain("<current_draft>");
  });

  it("lists every review check and the originality rules in the system prompt", () => {
    for (const check of REVIEW_CHECKS) expect(STORY_SYSTEM_PROMPT).toContain(check);
    expect(STORY_SYSTEM_PROMPT).toContain("Everything must be original");
  });
});
