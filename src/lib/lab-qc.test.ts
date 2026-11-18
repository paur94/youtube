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
        videoPrompt: [
          "Setup: Vera, black waistcoat, stands behind the bar on the left; Tom, navy raincoat, sits on a stool on the right, both hands flat on the bar. A full glass stands in front of Vera.",
          "Moves: Vera's right hand and the glass; then Tom's right hand.",
          "Stays still: Tom stays seated and upright on the stool until the glass arrives; the bottles on the shelf stay in place.",
          "0-3s: Vera pushes the glass with Vera's right hand; the glass slides along the bar to the right and stops in front of Tom.",
          "3-6s: Tom closes Tom's right hand around the glass and looks up at Vera.",
          "Camera: static, locked-off medium two-shot.",
          "Ends on: Vera's right hand rests on the bar; Tom holds the glass on the bar, looking at Vera.",
        ].join("\n"),
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

  it("warns when the motion prompt leaves positions and roles open", () => {
    const checks = labGateRules(input(story({ videoPrompt: "0-3s: Vera slides a glass to Tom.\n3-6s: He catches it and looks up." })));
    const open = checks.find((c) => c.label === "Motion prompt leaves positions and roles open");
    expect(open).toMatchObject({ status: "warning", group: "actions" });
    expect(open?.detail).toContain('"Stays still:"');
    expect(checks.find((c) => c.label === "Pronouns with several characters")?.detail).toContain('"he"');
  });

  it("checks the end frame and binds the approval to it", () => {
    const image = (id: string, contentType: string): LabGateJob => ({ id, sceneId: "s1", kind: "image", status: "completed", model: "grok-image-2", prompt: "Vera behind the bar, Tom on a stool, neon light.", filePath: `lab/${id}`, contentType, qc: null, createdAt: "2026-11-16T09:00:00Z" });
    const s = story({ startImageJobId: "img1", endImageJobId: "img2" });
    const ok = labGateRules(input(s, [image("img1", "image/png"), image("img2", "image/png")]));
    expect(ok.find((c) => c.label === "End frame")?.status).toBe("passed");
    const webp = labGateRules(input(s, [image("img1", "image/png"), image("img2", "image/webp")]));
    expect(webp.find((c) => c.label === "End frame format")).toMatchObject({ status: "critical", hard: true });
    const noStart = labGateRules(input(story({ endImageJobId: "img2" }), [image("img2", "image/png")]));
    expect(noStart.find((c) => c.label === "End frame without a start frame")?.status).toBe("warning");

    const plain = story({ startImageJobId: "img1" });
    expect(labContentKey(s, s.scenes[0], [], "9:16")).not.toBe(labContentKey(plain, plain.scenes[0], [], "9:16"));
  });

  it("blocks a prompt longer than Kling accepts", () => {
    const s = story();
    s.characters[0].look = "x ".repeat(13_500);
    expect(labGateRules(input(s)).find((c) => c.label === "Prompt is longer than Kling accepts")).toMatchObject({ status: "critical", hard: true });
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

  it("flags a scene its last review found over-full", () => {
    const review = { contentKey: "old", modelId: null, startAssetId: null, checkedAt: "2026-11-16T10:00:00Z", model: "gpt", frames: [], beats: [], checks: [], promptAdditions: "", suggestedPrompt: "", summary: "" };
    const over = { scenes: { s1: { review: { ...review, fit: { fits: false, secondsNeeded: 14.2, detail: "Eight separate actions." } }, approval: null, dismissed: [] } } };
    expect(labStoryChecks("A bar at night.", story(), over)[0]).toMatchObject({
      status: "warning",
      label: "Scene 1 has more action than 6s",
      fix: "Raise it to 15s, split it into 3 scenes, or cut events from the brief.",
    });
    const fits = { scenes: { s1: { review: { ...review, fit: { fits: true, secondsNeeded: 6, detail: "" } }, approval: null, dismissed: [] } } };
    expect(labStoryChecks("A bar at night.", story(), fits)).toEqual([]);
  });
});

describe("long motion prompts", () => {
  it("warns past 3,000 characters", () => {
    const long = story({ videoPrompt: `${story().scenes[0].videoPrompt}\n${"Vera keeps her left hand flat on the bar. ".repeat(80)}` });
    expect(labGateRules(input(long)).some((c) => c.label === "Motion prompt is long")).toBe(true);
    expect(labGateRules(input(story())).some((c) => c.label === "Motion prompt is long")).toBe(false);
  });
});
