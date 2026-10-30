import { describe, expect, it } from "vitest";

import { approvalBlockers, evaluateQuality, type QualityInput, summarizeQuality } from "./short-qc";
import { DEFAULT_VIDEO_SETTINGS, type ShortAnalysis } from "./shorts";

const analysis: ShortAnalysis = {
  standalone: { verdict: "strong", reasons: ["Complete mini-story"] },
  structure: { beginning: "a", middle: "b", ending: "c", clearArc: true, note: "" },
  opening: { strength: "strong", note: "Starts with a question" },
  hook: { onScreenText: "Can Mila do it?", rationale: "" },
  narrationSuggestions: [],
  music: { mood: "Playful", description: "" },
  soundEffects: [],
  metadata: { title: "t", description: "d", hashtags: [], playlist: "p" },
  childSafety: { status: "pass", notes: "Gentle" },
};

const vertical = { width: 1080, height: 1920, durationSeconds: 15, fps: 24, videoCodec: "h264", hasAudio: true, audioCodec: "aac", sampleRate: 48000, channels: 2, sizeBytes: 1 };

const ready: QualityInput = {
  sourceProbe: { ...vertical, width: 1280, height: 720 },
  outputProbe: vertical,
  outputAudio: { integratedLufs: -14.2, truePeakDbfs: -1.5, loudnessRangeLu: 4, silent: false },
  renderCurrent: true,
  rendered: true,
  settings: DEFAULT_VIDEO_SETTINGS,
  captions: [{ start: 0.5, end: 2.5, text: "A rectangle!" }],
  captionsReviewed: true,
  hasDialogue: true,
  hook: "Can Mila do it?",
  analysis,
  metadata: { title: "Mila's paper rocket", description: "Fold along.", hashtags: ["#shapes"] },
  metadataApproved: true,
  ffmpegAvailable: true,
};

const statusOf = (input: QualityInput, id: string) => evaluateQuality(input).find((c) => c.id === id)?.status;

describe("evaluateQuality", () => {
  it("passes a finished Short", () => {
    const checks = evaluateQuality(ready);
    expect(checks.filter((c) => c.status !== "pass").map((c) => c.id)).toEqual([]);
    expect(approvalBlockers(checks, { rendered: true, metadataApproved: true })).toEqual([]);
  });

  it("blocks approval before rendering and marks measurements unavailable without FFmpeg", () => {
    const input = { ...ready, rendered: false, renderCurrent: false, outputProbe: null, outputAudio: null, ffmpegAvailable: false };
    expect(statusOf(input, "render")).toBe("unavailable");
    expect(statusOf(input, "aspect")).toBe("unavailable");
    expect(approvalBlockers(evaluateQuality(input), { rendered: false, metadataApproved: true })).toContain("Render the vertical version first.");
  });

  it("fails a stale render, a non-vertical output and missing audio", () => {
    expect(statusOf({ ...ready, renderCurrent: false }, "render")).toBe("fail");
    expect(statusOf({ ...ready, outputProbe: { ...vertical, width: 1280, height: 720 } }, "aspect")).toBe("fail");
    expect(statusOf({ ...ready, outputProbe: { ...vertical, hasAudio: false } }, "audio")).toBe("fail");
    expect(statusOf({ ...ready, outputAudio: { ...ready.outputAudio!, silent: true } }, "audio")).toBe("fail");
  });

  it("warns about quiet audio, 720p output, cropping and upscaling", () => {
    expect(statusOf({ ...ready, outputAudio: { ...ready.outputAudio!, integratedLufs: -30 } }, "audio")).toBe("warn");
    expect(statusOf({ ...ready, outputProbe: { ...vertical, width: 720, height: 1280 } }, "resolution")).toBe("warn");
    const zoomed = { ...ready, settings: { ...DEFAULT_VIDEO_SETTINGS, zoom: 3 } };
    expect(statusOf(zoomed, "framing")).toBe("warn");
    expect(statusOf(zoomed, "resolution")).toBe("warn");
  });

  it("checks duration against the Shorts limits", () => {
    const at = (d: number) => statusOf({ ...ready, outputProbe: { ...vertical, durationSeconds: d } }, "duration");
    expect(at(15)).toBe("pass");
    expect(at(90)).toBe("warn");
    expect(at(181)).toBe("fail");
    expect(at(3)).toBe("warn");
  });

  it("asks for a caption review and fails broken timing", () => {
    expect(statusOf({ ...ready, captionsReviewed: false }, "captions")).toBe("warn");
    expect(statusOf({ ...ready, captions: [{ start: 10, end: 20, text: "too late" }] }, "captions")).toBe("fail");
    expect(statusOf({ ...ready, captions: [] }, "captions")).toBe("warn");
    expect(statusOf({ ...ready, captions: [], hasDialogue: false }, "captions")).toBe("pass");
  });

  it("flags weak standalone scenes and fails children's-content concerns", () => {
    const weak = { ...analysis, standalone: { verdict: "weak" as const, reasons: ["Depends on the previous scene"] } };
    const story = evaluateQuality({ ...ready, analysis: weak }).find((c) => c.id === "story")!;
    expect(story.status).toBe("warn");
    expect(story.details).toContain("Depends on the previous scene");
    expect(statusOf({ ...ready, analysis: { ...analysis, structure: { ...analysis.structure, clearArc: false } } }, "story")).toBe("warn");
    expect(statusOf({ ...ready, analysis: { ...analysis, childSafety: { status: "concern", notes: "Climbing" } } }, "children")).toBe("fail");
    expect(statusOf({ ...ready, analysis: null }, "children")).toBe("unavailable");
  });

  it("fails calls to action and requires metadata approval", () => {
    expect(statusOf({ ...ready, metadata: { ...ready.metadata, description: "Subscribe for more!" } }, "metadata")).toBe("fail");
    expect(statusOf({ ...ready, metadataApproved: false }, "metadata")).toBe("warn");
    expect(approvalBlockers(evaluateQuality({ ...ready, metadataApproved: false }), { rendered: true, metadataApproved: false })).toContain(
      "Approve the metadata first.",
    );
  });

  it("summarises statuses", () => {
    expect(summarizeQuality(evaluateQuality(ready))).toEqual({ pass: 11, warn: 0, fail: 0, unavailable: 0 });
  });
});
