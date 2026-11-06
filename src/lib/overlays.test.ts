import { describe, expect, it } from "vitest";

import { buildPreflightPrompt, buildVisionText } from "@/server/ai/qc-prompt";

import { videoRenderKey, type VideoClip, DEFAULT_EDIT_SETTINGS } from "./long-video";
import {
  buildOverlayBurnArgs,
  overlayFades,
  overlayLayout,
  overlayOpacityAt,
  placeOverlays,
  readOverlays,
  type SceneOverlay,
  sequenceOverlays,
  validateOverlays,
} from "./overlays";
import { buildGenerationPrompt, buildVideoPrompt, parseSceneForm } from "./production";
import { buildRenderArgs, computeFraming, OUT_H, OUT_W } from "./short-video";
import { DEFAULT_VIDEO_SETTINGS, renderKey } from "./shorts";
import { toQcScene } from "./story-qc";

const MESSAGE = "Working late. Love you.";
const bubble: SceneOverlay = { id: "o1", type: "bubble", text: MESSAGE, position: "top-right", start: 1, end: 4 };

// A production scene as stored, with a phone message to burn in during Final assembly.
const scene = {
  id: "6f1c2f8e-7d3b-4a5e-9c1d-2b3a4c5d6e7f",
  title: "Mum's message",
  setting: "Kitchen at dusk",
  action: "0-3s: Mila looks at her phone and smiles.\n3-6s: She puts the phone down on the table.",
  narration: "Mila got a message from Mum.",
  dialogue: [{ character: "Mila", line: "Mum is working late." }],
  visualPrompt: "A girl in a yellow jumper holds a phone in a cosy kitchen, soft 3D. No text.",
  negativePrompt: "",
  notes: "Phone screen faces away from camera.",
  durationSeconds: 6,
  overlays: [bubble],
};
const characters = [{ name: "Mila", visualDescription: "A 6-year-old girl with curly black hair." }];

describe("overlay prompt isolation", () => {
  it("never sends overlay text to the image, video, manual copy or Story QC prompts", () => {
    const prompts = [
      buildGenerationPrompt({ visualPrompt: scene.visualPrompt, characters, visualStyle: "Soft 3D" }),
      // API generation with and without a start image.
      ...[true, false].map((startImage) =>
        buildVideoPrompt({ ...scene, characters, visualStyle: "Soft 3D", startImage, voiced: true }),
      ),
      // The manual "copy prompt" path (startManualJob and the scene page's panel).
      buildVideoPrompt({ ...scene, characters, visualStyle: "Soft 3D", startImage: false, voiced: true, music: "Gentle piano" }),
    ];
    const qcScene = toQcScene(scene, 1, [{ ...characters[0], hasReference: true }]);
    const preflight = buildPreflightPrompt({
      title: "Story",
      visualStyle: "Soft 3D",
      characters: [{ name: "Mila", visualDescription: "", references: 1 }],
      scenes: [{ ...qcScene, referenceLabels: [] }],
    });
    prompts.push(preflight.system, preflight.user);
    prompts.push(buildVisionText({ scene: qcScene, shots: [], bible: null, frameTimes: [0, 3], referenceLabels: [], isImage: false }));

    expect(qcScene).not.toHaveProperty("overlays");
    for (const prompt of prompts) {
      expect(prompt).not.toContain(MESSAGE);
      expect(prompt).not.toContain("Love you");
    }
  });
});

describe("validateOverlays", () => {
  it("accepts overlays inside the scene", () => {
    expect(validateOverlays([bubble], 6)).toEqual([]);
    expect(validateOverlays([{ ...bubble, start: 0, end: 6 }], 6)).toEqual([]);
  });

  it("rejects empty or long text and times outside 0 <= start < end <= duration", () => {
    expect(validateOverlays([{ ...bubble, text: "  " }], 6)[0]).toBe("Overlay 1: add the text");
    expect(validateOverlays([{ ...bubble, text: "x".repeat(81) }], 6)[0]).toMatch(/under 80 characters/);
    expect(validateOverlays([{ ...bubble, start: -1 }], 6)[0]).toMatch(/can't be negative/);
    expect(validateOverlays([{ ...bubble, start: 4, end: 4 }], 6)[0]).toMatch(/end must be after the start/);
    expect(validateOverlays([bubble, { ...bubble, end: 7 }], 6)).toEqual(["Overlay 2: the end is after the scene ends (6s)"]);
  });

  it("is checked when the scene form is saved, against the form's duration", () => {
    const form = new FormData();
    form.set("title", "Scene");
    form.set("durationSeconds", "6");
    form.set("overlays", JSON.stringify([bubble]));
    expect(parseSceneForm(form).data?.overlays).toEqual([bubble]);

    form.set("durationSeconds", "3");
    const tooShort = parseSceneForm(form);
    expect(tooShort.success).toBe(false);
    expect(tooShort.error?.issues[0]).toMatchObject({ path: ["overlays"], message: "Overlay 1: the end is after the scene ends (3s)" });

    form.set("overlays", JSON.stringify([{ ...bubble, start: null }]));
    expect(parseSceneForm(form).success).toBe(false);
    form.set("overlays", "not json");
    expect(parseSceneForm(form).success).toBe(false);
  });

  it("defaults to no overlays", () => {
    const form = new FormData();
    form.set("title", "Scene");
    form.set("durationSeconds", "6");
    expect(parseSceneForm(form).data?.overlays).toEqual([]);
    expect(readOverlays(null)).toEqual([]);
    expect(readOverlays([bubble, { id: "x", type: "sticker" }])).toEqual([bubble]);
  });
});

describe("timing", () => {
  it("fades in and out over 0.4s by default, shortened for very short overlays", () => {
    expect(overlayFades(bubble)).toEqual({ fadeIn: 0.4, fadeOut: 0.4 });
    expect(overlayFades({ start: 0, end: 0.4 })).toEqual({ fadeIn: 0.2, fadeOut: 0.2 });
    expect(overlayFades({ ...bubble, fadeIn: 0, fadeOut: 1 })).toEqual({ fadeIn: 0, fadeOut: 1 });
  });

  it("is visible only between start and end", () => {
    expect(overlayOpacityAt(bubble, 0.9)).toBe(0);
    expect(overlayOpacityAt(bubble, 1.2)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(bubble, 2.5)).toBe(1);
    expect(overlayOpacityAt(bubble, 3.8)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(bubble, 4.1)).toBe(0);
  });
});

describe("overlayLayout", () => {
  it("scales with the frame height and keeps about 6% from the chosen corner", () => {
    const landscape = overlayLayout(bubble, { width: 1920, height: 1080 });
    expect(landscape.fontSize).toBe(54);
    expect(landscape.y).toBe(65);
    expect(1920 - landscape.x - landscape.width).toBe(115);
    expect(landscape.lines).toEqual([MESSAGE]);

    const vertical = overlayLayout({ ...bubble, position: "top-left" }, { width: 1080, height: 1920 });
    expect(vertical.fontSize).toBe(61);
    expect([vertical.x, vertical.y]).toEqual([65, 115]);
    expect(vertical.x + vertical.width).toBeLessThanOrEqual(1080);
  });

  it("wraps long text, centres top and bottom captions, and gives only bubbles a tail", () => {
    const frame = { width: 1920, height: 1080 };
    const long = overlayLayout({ ...bubble, text: "Don't forget the umbrella, it's going to rain later today!" }, frame);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.tailHeight).toBeGreaterThan(0);

    const caption = overlayLayout({ type: "caption", text: "Later that evening", position: "bottom-center" }, frame);
    expect(caption.tailHeight).toBe(0);
    expect(caption.x).toBe(Math.round((1920 - caption.width) / 2));
    expect(1080 - caption.y - caption.height).toBe(65);
  });
});

describe("buildOverlayBurnArgs", () => {
  it("fades each overlay's alpha and enables it only between its times", () => {
    const placed = placeOverlays([bubble, { ...bubble, id: "late", start: 9, end: 12 }], { width: 1920, height: 1080 }, 5, (i) => `o${i}.png`);
    expect(placed).toHaveLength(1);
    const args = buildOverlayBurnArgs({ inputPath: "in.mp4", outputPath: "out.mp4", durationSeconds: 5, fps: 24, overlays: placed });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[1:v]format=rgba,fade=in:st=1:d=0.4:alpha=1,fade=out:st=3.6:d=0.4:alpha=1[ov0]");
    expect(graph).toContain(`[0:v][ov0]overlay=x=${placed[0].x}:y=65:enable='between(t,1,4)'[v0]`);
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-framerate", "24", "-t", "5", "o0.png", "-c:a", "copy"]));
  });
});

describe("videoRenderKey", () => {
  it("changes with a clip's overlays, and not for clips without any", () => {
    const clip: VideoClip = {
      assetId: "a", sceneId: "s", sceneNumber: 1, title: "A", filePath: "a.mp4", sourceSeconds: 6,
      width: 1920, height: 1080, fps: 24, hasAudio: true, trimStart: 0, trimEnd: null, captions: [],
    };
    const base = videoRenderKey([clip], DEFAULT_EDIT_SETTINGS);
    expect(videoRenderKey([{ ...clip, overlays: [] }], DEFAULT_EDIT_SETTINGS)).toBe(base);
    expect(videoRenderKey([{ ...clip, overlays: [bubble] }], DEFAULT_EDIT_SETTINGS)).not.toBe(base);
  });
});

describe("Shorts", () => {
  it("puts a merged Short's overlays on its timeline, cut to each part", () => {
    const late = { ...bubble, id: "late", start: 5, end: 9 };
    const placed = sequenceOverlays([
      { overlays: [late], durationSeconds: 6 },
      { overlays: [bubble], durationSeconds: 8 },
    ]);
    expect(placed.map((o) => [o.id, o.start, o.end])).toEqual([["late", 5, 6], ["o1", 7, 10]]);
  });

  it("draws overlays in the 9:16 frame under the captions", () => {
    const placed = placeOverlays([bubble], { width: OUT_W, height: OUT_H }, 6, () => "overlay-0.png");
    const args = buildRenderArgs({
      inputPath: "in.mp4",
      outputPath: "out.mp4",
      framing: computeFraming(1280, 720, DEFAULT_VIDEO_SETTINGS),
      subtitlesFile: "overlay.ass",
      normalizeAudio: false,
      overlays: { placements: placed, durationSeconds: 6, fps: 24 },
    });
    expect(args).toEqual(expect.arrayContaining(["-loop", "1", "-framerate", "24", "-t", "6", "overlay-0.png"]));
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain(`[base][ov0]overlay=x=${placed[0].x}:y=${placed[0].y}:enable='between(t,1,4)'[v0]`);
    expect(graph.endsWith("[v0]ass=overlay.ass,format=yuv420p[v]")).toBe(true);
  });

  it("makes the render out of date when overlays change, and not for Shorts without any", () => {
    const base = { sourceFilePath: "a.mp4", settings: DEFAULT_VIDEO_SETTINGS, captions: [], hook: "", hookSeconds: 2 };
    expect(renderKey({ ...base, overlays: [] })).toBe(renderKey(base));
    expect(renderKey({ ...base, overlays: [bubble] })).not.toBe(renderKey(base));
    expect(renderKey({ ...base, overlays: [{ ...bubble, end: 5 }] })).not.toBe(renderKey({ ...base, overlays: [bubble] }));
  });
});
