import { describe, expect, it } from "vitest";

import { AGE_GROUP_LABELS } from "@/lib/ideas";

import { buildPublishOrderPrompt, buildShortAnalysisPrompt, SHORT_SYSTEM_PROMPT } from "./shorts-prompt";

const scene = {
  number: 2,
  total: 8,
  title: "A Rectangle!",
  setting: "Living room",
  action: "Papa holds up paper",
  narration: "",
  dialogue: [{ character: "Mila", line: "A rectangle!" }],
  durationSeconds: 15,
  soundEffects: ["paper rustle"],
  musicMood: "Curious",
};

describe("buildShortAnalysisPrompt", () => {
  it("includes the story, scene and neighbours", () => {
    const { system, user } = buildShortAnalysisPrompt({
      story: { title: "Mila's Paper Rocket", ageGroup: "3-5", language: "English", premise: "Mila builds a rocket.", learningOutcome: "Shapes" },
      scene,
      previousScene: '"A Rainy Space Day": Mila wants to go to space',
      nextScene: null,
    });
    expect(system).toBe(SHORT_SYSTEM_PROMPT);
    expect(user).toContain('<scene number="2" of="8">');
    expect(user).toContain("Mila: A rectangle!");
    expect(user).toContain("Clip length: 15 seconds");
    expect(user).toContain("Planned sound effects: paper rustle");
    expect(user).toContain("(this is the last scene)");
    expect(user).toContain(`Target age: ${AGE_GROUP_LABELS["3-5"]}`);
  });

  it("works when the story was deleted", () => {
    const { user } = buildShortAnalysisPrompt({ story: null, scene: { ...scene, durationSeconds: null }, previousScene: null, nextScene: null });
    expect(user).toContain("the original story was deleted");
    expect(user).toContain("Clip length: unknown");
  });

  it("forbids new footage and calls to action", () => {
    expect(SHORT_SYSTEM_PROMPT).toMatch(/Never suggest adding new footage/);
    expect(SHORT_SYSTEM_PROMPT).toMatch(/no calls to like, subscribe/);
  });
});

describe("buildPublishOrderPrompt", () => {
  it("numbers the Shorts and includes the verdicts", () => {
    const { user } = buildPublishOrderPrompt("Mila's Paper Rocket", [
      { number: 1, sceneNumber: 1, title: "Rainy day", analysis: null },
      {
        number: 2,
        sceneNumber: 2,
        title: "A rectangle",
        analysis: {
          standalone: { verdict: "weak", reasons: ["Needs context."] },
          structure: { beginning: "", middle: "", ending: "", clearArc: false, note: "" },
          opening: { strength: "ok", note: "" },
          hook: { onScreenText: "", rationale: "" },
          narrationSuggestions: [],
          music: { mood: "", description: "" },
          soundEffects: [],
          metadata: { title: "", description: "", hashtags: [], playlist: "" },
          childSafety: { status: "pass", notes: "" },
        },
      },
    ]);
    expect(user).toContain('Short 1: scene 1 "Rainy day". Not analysed yet');
    expect(user).toContain("Short 2: scene 2");
    expect(user).toContain("Weak standalone; opening ok; Needs context.");
  });
});
