import { describe, expect, it } from "vitest";

import { sampleContent } from "@/test/fixtures";

import {
  buildGenerationPrompt,
  clampDuration,
  describeDialogue,
  describeReferenceImages,
  DEFAULT_NEGATIVE_PROMPT,
  deriveSceneStatus,
  findPromptConcerns,
  isReadyForAssembly,
  moveInOrder,
  parseCharacterForm,
  parseSceneForm,
  scenesFromStory,
  summarizeCosts,
  summarizeProgress,
} from "./production";

describe("deriveSceneStatus", () => {
  const base = { visualPrompt: "A duckling", jobs: [], assets: [], selectedAssetApproved: false };

  it("needs a prompt before anything else", () => {
    expect(deriveSceneStatus({ ...base, visualPrompt: "  " })).toBe("draft");
    expect(deriveSceneStatus(base)).toBe("ready");
  });

  it("is generating while any job is active, including manual ones", () => {
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "queued" }] })).toBe("generating");
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "awaiting_manual" }] })).toBe("generating");
  });

  it("asks for review when an asset is pending, even if another job runs", () => {
    expect(
      deriveSceneStatus({ ...base, jobs: [{ status: "in_progress" }], assets: [{ status: "pending_review" }] }),
    ).toBe("review");
  });

  it("reports failure only when the latest job failed", () => {
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "timed_out" }, { status: "completed" }] })).toBe("failed");
    expect(deriveSceneStatus({ ...base, jobs: [{ status: "canceled" }, { status: "failed" }] })).toBe("ready");
  });

  it("is approved only with an approved final asset", () => {
    expect(deriveSceneStatus({ ...base, assets: [{ status: "approved" }] })).toBe("ready");
    expect(deriveSceneStatus({ ...base, assets: [{ status: "approved" }], selectedAssetApproved: true })).toBe("approved");
  });
});

describe("progress", () => {
  it("counts scenes per status and the approved share", () => {
    const progress = summarizeProgress([{ status: "approved" }, { status: "review" }, { status: "approved" }, { status: "draft" }]);
    expect(progress).toMatchObject({ total: 4, approved: 2, percent: 50 });
    expect(progress.counts).toMatchObject({ approved: 2, review: 1, draft: 1, failed: 0 });
  });

  it("handles an empty plan", () => {
    expect(summarizeProgress([])).toMatchObject({ total: 0, percent: 0 });
    expect(isReadyForAssembly([])).toBe(false);
  });

  it("requires every scene to be approved before assembly", () => {
    expect(isReadyForAssembly([{ status: "approved" }, { status: "review" }])).toBe(false);
    expect(isReadyForAssembly([{ status: "approved" }, { status: "approved" }])).toBe(true);
  });
});

describe("summarizeCosts", () => {
  it("sums estimates for chargeable API jobs and counts the rest", () => {
    const costs = summarizeCosts([
      { mode: "api", status: "completed", estimatedCostUsd: "0.0940" },
      { mode: "api", status: "queued", estimatedCostUsd: "0.5" },
      { mode: "api", status: "failed", estimatedCostUsd: "1.00" }, // not charged
      { mode: "api", status: "completed", estimatedCostUsd: null },
      { mode: "manual", status: "completed", estimatedCostUsd: null },
    ]);
    expect(costs.estimatedUsd).toBeCloseTo(0.594);
    expect(costs).toMatchObject({ estimatedJobs: 2, unpricedJobs: 1, manualJobs: 1 });
  });

  it("returns null when no price is known", () => {
    expect(summarizeCosts([{ mode: "api", status: "completed", estimatedCostUsd: null }]).estimatedUsd).toBeNull();
  });
});

describe("buildGenerationPrompt", () => {
  it("appends consistent character descriptions and the style", () => {
    const prompt = buildGenerationPrompt({
      visualPrompt: "Pip splashes in a puddle.",
      characters: [{ name: "Pip", visualDescription: "Small yellow duckling in a blue raincoat." }],
      visualStyle: "Soft 3D animation",
    });
    expect(prompt).toContain("Pip splashes in a puddle.");
    expect(prompt).toContain("Pip: Small yellow duckling in a blue raincoat.");
    expect(prompt).toContain("Visual style: Soft 3D animation.");
  });

  it("doesn't repeat a style the prompt already has", () => {
    const prompt = buildGenerationPrompt({
      visualPrompt: "Soft 3D animation, pastel colours. A cosy room.",
      characters: [],
      visualStyle: "soft 3d animation, pastel colours",
    });
    expect(prompt).toBe("Soft 3D animation, pastel colours. A cosy room.");
  });
});

describe("describeDialogue", () => {
  it("quotes each spoken line with its speaker, in order", () => {
    const text = describeDialogue([
      { character: "Pip", line: "Puddles!" },
      { character: "Mila", line: " Let's count them! " },
      { character: "Pip", line: "  " },
    ]);
    expect(text).toContain('Pip says, "Puddles!"');
    expect(text).toContain('Then Mila says, "Let\'s count them!"');
    expect(text.indexOf("Pip says")).toBeLessThan(text.indexOf("Mila says"));
    expect(text.match(/says/g)).toHaveLength(2);
  });

  it("keeps listeners' mouths closed on each line, including on-screen characters without lines", () => {
    const text = describeDialogue(
      [
        { character: "Papa", line: "What shape is it?" },
        { character: "Mila", line: "A rectangle!" },
      ],
      ["Mila", "Papa", "Zip"],
    );
    expect(text).toContain('Papa says, "What shape is it?", while Mila and Zip listen silently with mouth closed');
    expect(text).toContain('Mila says, "A rectangle!", while Papa and Zip listen silently with mouth closed');
    expect(text).toContain("Only one character speaks at a time");
  });

  it("treats unnamed lines as a voice-over with no lip movement", () => {
    const text = describeDialogue([
      { character: "", line: "Once upon a time." },
      { character: "Mila", line: "Hello!" },
    ]);
    expect(text).toContain('a voice-over narrator says, "Once upon a time.", and no one on screen moves their lips');
    expect(text).toContain('Mila says, "Hello!"');
    expect(text).not.toContain("while Narrator");
  });

  it("is empty when the scene has no dialogue", () => {
    expect(describeDialogue([])).toBe("");
  });
});

describe("describeReferenceImages", () => {
  it("maps each attached image to its characters in order", () => {
    expect(describeReferenceImages([["Mila"], ["Papa"]])).toContain("image 1 shows Mila; image 2 shows Papa");
    expect(describeReferenceImages([["Mila", "Papa", "Zip"]])).toContain("image 1 shows Mila, Papa and Zip");
    expect(describeReferenceImages([])).toBe("");
  });
});

describe("findPromptConcerns", () => {
  it("flags existing franchises and studios", () => {
    expect(findPromptConcerns("A pig that looks like Peppa Pig")[0]).toContain("peppa pig");
    expect(findPromptConcerns("Disney-like castle")[0]).toContain("disney");
  });

  it("flags imitating an artist's style", () => {
    expect(findPromptConcerns("A forest in the style of a famous painter")).toHaveLength(1);
  });

  it("doesn't flag ordinary words that contain a name", () => {
    expect(findPromptConcerns("Elmore the legolike block builder with frozen peas")).toEqual([]);
    expect(findPromptConcerns("Original duckling, soft 3D, pastel")).toEqual([]);
  });
});

describe("scenesFromStory", () => {
  it("imports scenes in storyboard order with defaults", () => {
    const shuffled = { scenes: [...sampleContent.scenes].reverse() };
    const drafts = scenesFromStory(shuffled);
    expect(drafts.map((d) => d.title)).toEqual(sampleContent.scenes.map((s) => s.title));
    expect(drafts[0]).toMatchObject({
      narration: sampleContent.scenes[0].narration,
      visualPrompt: sampleContent.scenes[0].visualPrompt,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      characterNames: ["Pip"],
    });
  });

  it("clamps durations to a sensible range", () => {
    expect(clampDuration(0)).toBe(5);
    expect(clampDuration(12.4)).toBe(12);
    expect(clampDuration(5000)).toBe(600);
  });
});

describe("moveInOrder", () => {
  it("swaps neighbours and ignores moves past the ends", () => {
    expect(moveInOrder(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b"], "a", "up")).toEqual(["a", "b"]);
    expect(moveInOrder(["a", "b"], "x", "up")).toEqual(["a", "b"]);
  });
});

describe("forms", () => {
  it("parses a scene form, including dialogue and characters", () => {
    const form = new FormData();
    form.set("title", " Rainy morning ");
    form.set("durationSeconds", "8");
    form.set("dialogue", "Pip: Puddles!\nWhat fun");
    form.append("characterIds", "6f1c2f8e-7d3b-4a5e-9c1d-2b3a4c5d6e7f");
    const parsed = parseSceneForm(form);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      title: "Rainy morning",
      durationSeconds: 8,
      dialogue: [
        { character: "Pip", line: "Puddles!" },
        { character: "Narrator", line: "What fun" },
      ],
      characterIds: ["6f1c2f8e-7d3b-4a5e-9c1d-2b3a4c5d6e7f"],
    });
  });

  it("rejects invalid scene durations", () => {
    const form = new FormData();
    form.set("title", "Scene");
    form.set("durationSeconds", "0");
    expect(parseSceneForm(form).success).toBe(false);
  });

  it("requires a usable visual description for characters", () => {
    const form = new FormData();
    form.set("name", "Pip");
    form.set("visualDescription", "duck");
    expect(parseCharacterForm(form).success).toBe(false);
    form.set("visualDescription", "Small round yellow duckling with a blue raincoat");
    expect(parseCharacterForm(form).data).toMatchObject({ name: "Pip", status: "draft" });
  });
});
