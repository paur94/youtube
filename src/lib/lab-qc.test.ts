import { describe, expect, it } from "vitest";

import type { LabStory } from "./lab";
import { buildLabGateInput, evaluateLabGate, type LabGateJob, labContentKey, labGateRules, labStoryChecks } from "./lab-qc";

function story(overrides: Partial<LabStory["scenes"][number]> = {}): LabStory {
  return {
    title: "Last call",
    logline: "A bartender stalls a stranger.",
    characters: [
      { name: "Vera", look: "a woman in her forties, short grey hair, black waistcoat over a white shirt, silver ring" },
      { name: "Tom", look: "a tall man in his thirties, wet navy raincoat, stubble, tired eyes" },
    ],
    scenes: [
      {
        id: "s1",
        title: "The bar",
        imagePrompt: "Vera behind the bar, Tom on a stool, neon light.",
        videoPrompt: "0-3s: Vera slides a glass to Tom.\n3-6s: Tom catches it and looks up.",
        dialogue: "Vera: We're closing.\nTom: Just one more.",
        durationSeconds: 6,
        startImageJobId: null,
        ...overrides,
      },
    ],
  };
}

function input(s: LabStory, jobs: LabGateJob[] = [], qc = {}) {
  return buildLabGateInput({ story: s, sceneId: "s1", references: [], aspectRatio: "9:16", qc, jobs, aiConfigured: true })!;
}

describe("labGateRules", () => {
  it("passes a consistent scene except for the missing review", () => {
    const checks = labGateRules(input(story()));
    const open = checks.filter((c) => c.status !== "passed").map((c) => c.label);
    expect(open).toEqual(["No visual anchor", "AI review not run"]);
  });

  it("treats a narrator line as critical", () => {
    const checks = labGateRules(input(story({ dialogue: "Narrator: That night everything changed.\nVera: We're closing." })));
    expect(checks.find((c) => c.label === "Narrator or voice-over line")?.status).toBe("critical");
  });

  it("warns about speakers outside the cast", () => {
    const checks = labGateRules(input(story({ dialogue: "Vera: We're closing.\nMara: Not yet." })));
    expect(checks.find((c) => c.label === "Speaker not in the cast")?.detail).toContain("Mara");
  });

  it("flags a start frame generated from an older image prompt", () => {
    const s = story({ startImageJobId: "img1", imagePrompt: "Vera alone, wiping the counter." });
    const jobs: LabGateJob[] = [
      { id: "img1", sceneId: "s1", kind: "image", status: "completed", model: "grok-image-2", prompt: "Vera behind the bar, Tom on a stool, neon light.\n\nCharacters...", filePath: "lab/a.png", contentType: "image/png", qc: null, createdAt: "2026-11-16T09:00:00Z" },
    ];
    const checks = labGateRules(input(s, jobs));
    expect(checks.find((c) => c.label === "Start frame is from an older image prompt")?.status).toBe("warning");
  });

  it("requires the previous clip to be inspected before regenerating", () => {
    const jobs: LabGateJob[] = [
      { id: "v1", sceneId: "s1", kind: "video", status: "completed", model: "kling", prompt: "...", filePath: "lab/v.mp4", contentType: "video/mp4", qc: null, createdAt: "2026-11-16T09:00:00Z" },
    ];
    expect(labGateRules(input(story(), jobs)).find((c) => c.label === "Previous clip not inspected")?.status).toBe("critical");
  });
});

describe("lab approval", () => {
  it("is bound to the exact version", () => {
    const s = story();
    const key = labContentKey(s, s.scenes[0], [], "9:16");
    const qc = {
      scenes: {
        s1: {
          review: { contentKey: key, modelId: null, startAssetId: null, checkedAt: "2026-11-16T10:00:00Z", model: "gpt", frames: [], beats: [], checks: [], promptAdditions: "", suggestedPrompt: "", summary: "" },
          approval: { contentKey: key, modelId: null, startAssetId: null, approvedAt: "2026-11-16T10:01:00Z" },
          dismissed: [] as string[],
        },
      },
    };
    const approved = evaluateLabGate(input(s, [], qc));
    // "No visual anchor" is only a warning, so the approved version can go out.
    expect(approved.canGenerate).toBe(true);

    const edited = story({ dialogue: "Vera: We're closed." });
    expect(evaluateLabGate(input(edited, [], qc)).canGenerate).toBe(false);
  });
});

describe("labStoryChecks", () => {
  it("compares the total length with the brief", () => {
    expect(labStoryChecks("Duration: 15 seconds. A bar at night.", story())[0]).toMatchObject({ status: "warning", label: "Total length differs from the brief" });
    expect(labStoryChecks("Duration: 6 seconds.", story())[0].status).toBe("passed");
  });
});
