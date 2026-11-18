import { describe, expect, it } from "vitest";

import { buildLabImagePrompt, buildLabVideoPrompt, clampSeconds, klingPromptLimit, type LabStory, labStorySchema, storyFromOutput } from "./lab";

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
    // The cast still goes along so Kling can tell which figure in the frame is which.
    expect(prompt).toContain("Cast, to tell the figures in @image_1 apart");
    expect(prompt).toContain("Mara: 40s, short grey hair");
  });

  it("names the end frame only when a start frame goes with it", () => {
    const scene = { ...story.scenes[0], startImageJobId: "img1", endImageJobId: "img2" };
    expect(buildLabVideoPrompt(story, scene, "startImage", 0)).toContain("@image_2 is the last frame");
    expect(buildLabVideoPrompt(story, { ...scene, startImageJobId: null }, "text", 0)).not.toContain("@image_2");
  });

  it("applies Kling's lower prompt limit to non-English prompts", () => {
    expect(klingPromptLimit("Mara stops and turns.")).toBe(26_000);
    expect(klingPromptLimit("Мара останавливается и оборачивается.")).toBe(11_000);
  });

  it("tags Kling reference images in order", () => {
    const prompt = buildLabVideoPrompt({ ...story, scenes: [{ ...story.scenes[0], dialogue: "" }] }, story.scenes[0], "references", 3);
    expect(prompt).toContain("@image_1, @image_2 and @image_3 are references");
    expect(prompt).toContain("Characters:\nMara");
  });

  it("doesn't contradict the motion prompt's own image roles or sound plan", () => {
    const plain = buildLabVideoPrompt(story, { ...story.scenes[0], dialogue: "" }, "references", 2);
    expect(plain).toContain("@image_1 and @image_2 are references for the characters and the style");
    expect(plain).toContain("ambient sound only");

    const scene = { ...story.scenes[0], dialogue: "", videoPrompt: "@image_1 is Mara's look only.\nSound: soft piano music, footsteps." };
    const own = buildLabVideoPrompt({ ...story, scenes: [scene] }, scene, "references", 2);
    expect(own).not.toContain("are references for");
    expect(own).not.toContain("ambient sound only");
    expect(own).toContain("No dialogue, no narrator and no voice-over.");
  });
});
