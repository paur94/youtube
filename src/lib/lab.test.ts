import { describe, expect, it } from "vitest";

import { buildLabImagePrompt, buildLabVideoPrompt, clampSeconds, type LabStory, labStorySchema, storyFromOutput } from "./lab";

const story: LabStory = {
  title: "Night Shift",
  logline: "A nurse finds a stranger in the empty ward.",
  characters: [{ name: "Mara", look: "40s, short grey hair, navy scrubs" }],
  scenes: [
    {
      id: "a1",
      title: "Empty ward",
      imagePrompt: "Mara walks down a dim hospital corridor",
      videoPrompt: "Slow dolly forward as Mara stops and turns",
      dialogue: "Mara: Who's there?",
      durationSeconds: 6,
      startImageJobId: null,
    },
  ],
};

describe("lab story", () => {
  it("clamps durations to Kling's 3-30s range", () => {
    expect(clampSeconds(1)).toBe(3);
    expect(clampSeconds(45)).toBe(30);
    expect(clampSeconds(7.4)).toBe(7);
    expect(clampSeconds(Number.NaN)).toBe(5);
  });

  it("turns Claude's output into a valid editable story", () => {
    const result = storyFromOutput({
      title: " T ",
      logline: "L",
      characters: [],
      scenes: [{ title: "S", imagePrompt: "I", videoPrompt: "V", dialogue: "", durationSeconds: 60 }],
    });
    expect(result.title).toBe("T");
    expect(result.scenes[0]).toMatchObject({ durationSeconds: 30, startImageJobId: null });
    expect(labStorySchema.safeParse(result).success).toBe(true);
  });

  it("adds the cast and the reference note to image prompts", () => {
    const prompt = buildLabImagePrompt(story, story.scenes[0], 2);
    expect(prompt).toContain("Mara: 40s, short grey hair");
    expect(prompt).toContain("2 attached images are references");
  });

  it("keeps dialogue on screen with no narrator in clip prompts", () => {
    const prompt = buildLabVideoPrompt(story, story.scenes[0], "startImage", 0);
    expect(prompt).toContain("@image_1 is the first frame");
    expect(prompt).toContain("Mara: Who's there?");
    expect(prompt).toContain("No narrator and no voice-over");
    expect(prompt).not.toContain("Characters:");
  });

  it("tags Kling reference images in order", () => {
    const prompt = buildLabVideoPrompt({ ...story, scenes: [{ ...story.scenes[0], dialogue: "" }] }, story.scenes[0], "references", 3);
    expect(prompt).toContain("@image_1, @image_2 and @image_3 are references");
    expect(prompt).toContain("Characters:\nMara");
  });
});
