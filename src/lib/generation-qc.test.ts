import { describe, expect, it } from "vitest";

import {
  countActions,
  evaluateGate,
  evaluateKidsGate,
  gateBlocker,
  gateCheck,
  type GateReview,
  type KidsGateContext,
  type KidsGateModel,
  kidsGateRules,
  timelineChecks,
} from "./generation-qc";

const statuses = (checks: { status: string; label: string }[]) => checks.map((c) => `${c.status}:${c.label}`);

describe("timelineChecks", () => {
  it("passes timed beats that cover the clip", () => {
    const checks = timelineChecks({ sceneSeconds: 8, requestedSeconds: 8, motion: "0-3s: Mila opens the box.\n3-6s: She lifts the kitten out.\n6-8s: She smiles at the camera." });
    expect(statuses(checks)).toEqual(["passed:Timed beats fit the clip"]);
  });

  it("flags beats that run past the clip as critical", () => {
    const checks = timelineChecks({ sceneSeconds: 5, requestedSeconds: 5, motion: "0-3s: Mila opens the box.\n3-7s: She lifts the kitten out." });
    expect(checks[0].status).toBe("critical");
    expect(checks[0].detail).toContain("runs past the 5s clip");
  });

  it("warns about gaps and dead time at the end", () => {
    const checks = timelineChecks({ sceneSeconds: 10, requestedSeconds: 10, motion: "0-2s: He sits down.\n4-6s: He opens the letter." });
    expect(checks[0].status).toBe("warning");
    expect(checks[0].detail).toContain("nothing is planned between 2s and 4s");
    expect(checks[0].detail).toContain("last 4s");
  });

  it("is critical when the model makes a shorter clip than the scene", () => {
    const checks = timelineChecks({ sceneSeconds: 8, requestedSeconds: 5, motion: "She waves." });
    expect(checks[0]).toMatchObject({ status: "critical", label: "The model makes a shorter clip than the scene" });
  });

  it("flags more untimed action than fits", () => {
    const motion = "He runs to the door. Then he opens it. Then he steps outside. Then he looks up at the sky. Then he laughs loudly.";
    expect(countActions(motion)).toBe(5);
    expect(timelineChecks({ sceneSeconds: 4, requestedSeconds: 4, motion })[0]).toMatchObject({ status: "warning", label: "Too much action for the clip length" });
  });

  it('reads beats timed as "0–2 seconds:"', () => {
    const checks = timelineChecks({ sceneSeconds: 5, requestedSeconds: 5, motion: "Locked camera.\n0–2 seconds: He aims.\n2–5 seconds: She walks in and stops." });
    expect(statuses(checks)).toEqual(["passed:Timed beats fit the clip"]);
  });

  it("checks the speaking pace when asked", () => {
    const fast = timelineChecks({ sceneSeconds: 4, requestedSeconds: 4, motion: "She talks.", spokenWords: 20 });
    expect(fast.at(-1)).toMatchObject({ status: "critical", label: "Dialogue doesn't fit the clip" });
    const fine = timelineChecks({ sceneSeconds: 6, requestedSeconds: 6, motion: "She talks.", spokenWords: 12 });
    expect(fine.at(-1)?.status).toBe("passed");
  });
});

function review(overrides: Partial<GateReview> = {}): GateReview {
  return {
    contentKey: "k1",
    modelId: "kling",
    startAssetId: "img1",
    checkedAt: "2026-11-16T10:00:00.000Z",
    model: "test",
    frames: [],
    beats: [],
    checks: [gateCheck("ai", "actions", "critical", "The cup floats", "The cup leaves her hand without a cause.", { fix: "Keep the cup in her right hand." })],
    promptAdditions: "",
    suggestedPrompt: "",
    summary: "",
    ...overrides,
  };
}

describe("evaluateGate", () => {
  const selection = { modelId: "kling", startAssetId: "img1" };

  it("uses the review only for the exact version it checked", () => {
    const current = evaluateGate({ rules: [], state: { review: review(), approval: null }, contentKey: "k1", selection, dismissed: [] });
    expect(current.reviewCurrent).toBe(true);
    expect(current.critical).toHaveLength(1);
    const edited = evaluateGate({ rules: [], state: { review: review(), approval: null }, contentKey: "k2", selection, dismissed: [] });
    expect(edited.reviewCurrent).toBe(false);
    expect(edited.critical).toHaveLength(0);
    const otherStart = evaluateGate({ rules: [], state: { review: review(), approval: null }, contentKey: "k1", selection: { ...selection, startAssetId: "img2" }, dismissed: [] });
    expect(otherStart.reviewCurrent).toBe(false);
  });

  it("lets soft issues be dismissed but never hard ones", () => {
    const soft = review().checks[0];
    const hard = gateCheck("rules", "request", "critical", "No start image", "none", { hard: true });
    const result = evaluateGate({ rules: [hard], state: { review: review(), approval: null }, contentKey: "k1", selection, dismissed: [soft.id, hard.id] });
    expect(result.critical.map((c) => c.label)).toEqual(["No start image"]);
    expect(result.dismissed.map((c) => c.label)).toEqual(["The cup floats"]);
    expect(result.canApprove).toBe(false);
  });

  it("only generates an approved version without open critical issues", () => {
    const approval = { contentKey: "k1", modelId: "kling", startAssetId: "img1", approvedAt: "2026-11-16T10:05:00.000Z" };
    const clean = review({ checks: [] });
    const ok = evaluateGate({ rules: [], state: { review: clean, approval }, contentKey: "k1", selection, dismissed: [] });
    expect(ok.canGenerate).toBe(true);
    expect(gateBlocker(ok)).toBeNull();
    const edited = evaluateGate({ rules: [], state: { review: clean, approval }, contentKey: "k2", selection, dismissed: [] });
    expect(edited.approved).toBe(false);
    expect(gateBlocker(edited)).toContain("approve this exact version");
    const otherModel = evaluateGate({ rules: [], state: { review: clean, approval }, contentKey: "k1", selection: { ...selection, modelId: "wan" }, dismissed: [] });
    expect(otherModel.canGenerate).toBe(false);
  });
});

function ctx(overrides: Partial<KidsGateContext> = {}): KidsGateContext {
  return {
    contentKey: "k1",
    durationSeconds: 5,
    action: "0-3s: Mila waves.\n3-5s: Levon waves back.",
    startImages: { img1: { label: "Scene keyframe r1", sceneKeyframe: true, contentType: "image/png" } },
    frames: { middle: 0, end: false, missing: 0 },
    storyQc: { openCritical: [], preflightCurrent: true, preflightStale: false },
    previousClip: null,
    aiConfigured: true,
    state: { review: null, approval: null },
    dismissed: [],
    ...overrides,
  };
}

const kling: KidsGateModel = { id: "kling", label: "Kling 4.0", input: "image", keyframes: true, requestedSeconds: 5 };

describe("kidsGateRules", () => {
  it("requires a start image and the AI review", () => {
    const checks = kidsGateRules(ctx(), kling, null);
    expect(checks.find((c) => c.label === "No start image")).toMatchObject({ status: "critical", hard: true });
    expect(checks.find((c) => c.label === "AI review not run")).toMatchObject({ status: "critical", hard: true });
  });

  it("rejects start images Kling can't read", () => {
    const checks = kidsGateRules(ctx({ startImages: { img1: { label: "r1", sceneKeyframe: true, contentType: "image/webp" } } }), kling, "img1");
    expect(checks.find((c) => c.label === "Start image format")?.status).toBe("critical");
  });

  it("blocks regeneration until the previous clip is inspected", () => {
    const checks = kidsGateRules(ctx({ previousClip: { revision: 2, inspection: "none" } }), kling, "img1");
    expect(checks.find((c) => c.label === "Previous clip not inspected")?.status).toBe("critical");
    const offline = kidsGateRules(ctx({ aiConfigured: false, previousClip: { revision: 2, inspection: "none" } }), kling, "img1");
    expect(offline.find((c) => c.label === "Previous clip not inspected")?.status).toBe("warning");
    expect(offline.find((c) => c.label === "AI review unavailable")?.status).toBe("warning");
  });

  it("passes a reviewed, approved version", () => {
    const state = {
      review: review({ checks: [] }),
      approval: { contentKey: "k1", modelId: "kling", startAssetId: "img1", approvedAt: "2026-11-16T10:05:00.000Z" },
    };
    const result = evaluateKidsGate(ctx({ state }), kling, "img1");
    expect(result.critical).toEqual([]);
    expect(result.canGenerate).toBe(true);
    // Hedra (no model) accepts any approved version with the same start image.
    expect(evaluateKidsGate(ctx({ state }), null, "img1").canGenerate).toBe(true);
    expect(evaluateKidsGate(ctx({ state }), null, "other").canGenerate).toBe(false);
  });
});
