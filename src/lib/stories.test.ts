import { describe, expect, it } from "vitest";

import { sampleContent } from "@/test/fixtures";

import {
  formatDialogue,
  formatDuration,
  MAX_CONTENT_BYTES,
  parseDialogue,
  parseList,
  parseStoryContentJson,
  parseStoryForm,
  sumSceneDurations,
} from "./stories";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const validForm = {
  ideaId: "",
  title: "  Pip and the Puddles  ",
  ageGroup: "3-5",
  topic: "Counting puddles",
  learningObjective: "Count to five",
  characters: "",
  targetDurationSeconds: "180",
  tone: "Playful",
  visualStyle: "Watercolour",
  language: "English",
  notes: "",
};

describe("parseStoryForm", () => {
  it("accepts a valid brief and normalises it", () => {
    const result = parseStoryForm(form(validForm));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ ideaId: null, title: "Pip and the Puddles", targetDurationSeconds: 180 });
  });

  it("reports field errors for missing or invalid values", () => {
    const result = parseStoryForm(
      form({ ...validForm, title: "Hi", topic: "", targetDurationSeconds: "7", ageGroup: "13-99" }),
    );
    expect(result.success).toBe(false);
    const fields = result.error!.issues.map((i) => i.path[0]);
    expect(fields).toEqual(expect.arrayContaining(["title", "topic", "targetDurationSeconds", "ageGroup"]));
  });

  it("rejects an idea id that is not a uuid", () => {
    expect(parseStoryForm(form({ ...validForm, ideaId: "not-a-uuid" })).success).toBe(false);
    const id = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(parseStoryForm(form({ ...validForm, ideaId: id })).data?.ideaId).toBe(id);
  });
});

describe("parseStoryContentJson", () => {
  it("accepts valid content", () => {
    expect(parseStoryContentJson(JSON.stringify(sampleContent))).toEqual({ success: true, data: sampleContent });
  });

  it("rejects malformed JSON, wrong shapes and empty titles", () => {
    expect(parseStoryContentJson("{").success).toBe(false);
    const wrongShape = parseStoryContentJson(JSON.stringify({ ...sampleContent, scenes: "nope" }));
    expect(wrongShape).toMatchObject({ success: false, message: expect.stringContaining("scenes") });
    expect(parseStoryContentJson(JSON.stringify({ ...sampleContent, title: "  " })).success).toBe(false);
  });

  it("rejects oversized payloads", () => {
    const huge = JSON.stringify({ ...sampleContent, narration: "x".repeat(MAX_CONTENT_BYTES) });
    expect(parseStoryContentJson(huge)).toMatchObject({ success: false, message: expect.stringContaining("too large") });
  });
});

describe("editor helpers", () => {
  it("round-trips dialogue in 'Name: line' form", () => {
    const lines = [
      { character: "Pip", line: "Hello: friend!" },
      { character: "Grandma Hen", line: "Hi Pip." },
    ];
    expect(parseDialogue(formatDialogue(lines))).toEqual(lines);
    expect(parseDialogue("\nJust a line without a speaker\n")).toEqual([
      { character: "Narrator", line: "Just a line without a speaker" },
    ]);
  });

  it("parses comma lists and sums scene durations", () => {
    expect(parseList(" rain, , splash ,giggle")).toEqual(["rain", "splash", "giggle"]);
    expect(sumSceneDurations(sampleContent)).toBe(120);
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(180)).toBe("3 min");
    expect(formatDuration(95)).toBe("1m 35s");
  });
});
