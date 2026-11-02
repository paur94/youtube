import { describe, expect, it } from "vitest";

import {
  buildChapters,
  buildConcatArgs,
  buildLandscapeAss,
  clipLength,
  computeTimeline,
  DEFAULT_EDIT_SETTINGS,
  descriptionWithChapters,
  type EditSettings,
  evaluateVideoQuality,
  formatTimestamp,
  parseProgressSeconds,
  pickFps,
  timelineCaptions,
  type VideoClip,
  videoApprovalBlockers,
  videoRenderKey,
} from "./long-video";

function clip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    assetId: "a",
    sceneId: "s",
    sceneNumber: 1,
    title: "Scene",
    filePath: "scenes/s/a.mp4",
    sourceSeconds: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    trimStart: 0,
    trimEnd: null,
    captions: [],
    ...overrides,
  };
}

const cut: EditSettings = { ...DEFAULT_EDIT_SETTINGS, transition: "cut" };
const fade: EditSettings = { ...DEFAULT_EDIT_SETTINGS, transition: "crossfade", transitionSeconds: 1 };

describe("computeTimeline", () => {
  it("places clips back to back with hard cuts", () => {
    const t = computeTimeline([clip(), clip({ trimStart: 2, trimEnd: 6 }), clip()], cut);
    expect(t.overlap).toBe(0);
    expect(t.segments).toEqual([
      { start: 0, length: 10 },
      { start: 10, length: 4 },
      { start: 14, length: 10 },
    ]);
    expect(t.total).toBe(24);
  });

  it("overlaps neighbours by the transition length", () => {
    const t = computeTimeline([clip(), clip(), clip()], fade);
    expect(t.segments.map((s) => s.start)).toEqual([0, 9, 18]);
    expect(t.total).toBe(28);
  });

  it("caps the overlap at half the shortest clip", () => {
    const t = computeTimeline([clip(), clip({ trimEnd: 1 })], { ...fade, transitionSeconds: 2 });
    expect(t.overlap).toBe(0.5);
    expect(t.total).toBe(10.5);
  });

  it("has no overlap for a single clip", () => {
    expect(computeTimeline([clip()], fade)).toEqual({ segments: [{ start: 0, length: 10 }], overlap: 0, total: 10 });
  });
});

describe("clipLength", () => {
  it("uses the trim points", () => {
    expect(clipLength(clip({ trimStart: 1.25, trimEnd: 4 }))).toBe(2.75);
    expect(clipLength(clip({ trimStart: 3 }))).toBe(7);
  });
});

describe("timelineCaptions", () => {
  it("moves each clip's captions to its place on the timeline and drops trimmed ones", () => {
    const clips = [
      clip({ captions: [{ start: 1, end: 2, text: "one" }] }),
      clip({
        trimStart: 2,
        trimEnd: 8,
        captions: [
          { start: 0.5, end: 1.5, text: "cut away" },
          { start: 1.5, end: 3, text: "starts before trim" },
          { start: 7.5, end: 9, text: "runs past trim" },
        ],
      }),
    ];
    const t = computeTimeline(clips, fade);
    expect(timelineCaptions(clips, t)).toEqual([
      { start: 1, end: 2, text: "one" },
      { start: 9, end: 10, text: "starts before trim" },
      { start: 14.5, end: 15, text: "runs past trim" },
    ]);
  });
});

describe("buildConcatArgs", () => {
  const inputs = (clips: VideoClip[]) => clips.map((c, i) => ({ ...c, inputPath: `C:/media/${i}.mp4` }));

  it("concatenates with hard cuts and seeks into trimmed clips", () => {
    const clips = [clip({ trimStart: 1, trimEnd: 5 }), clip()];
    const { args, durationSeconds } = buildConcatArgs({ clips: inputs(clips), settings: cut, outputPath: "out.mp4", subtitlesFile: null, fps: 30 });
    expect(durationSeconds).toBe(14);
    expect(args.slice(3, 9)).toEqual(["-ss", "1", "-t", "4", "-i", "C:/media/0.mp4"]);
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vj][aj]");
    expect(graph).toContain("scale=1920:1080:force_original_aspect_ratio=decrease");
    expect(graph).toContain("loudnorm=I=-14");
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("chains xfade and acrossfade with timeline offsets", () => {
    const clips = [clip(), clip(), clip()];
    const { args } = buildConcatArgs({ clips: inputs(clips), settings: fade, outputPath: "out.mp4", subtitlesFile: "captions.ass", fps: 25 });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[v0][v1]xfade=transition=fade:duration=1:offset=9[vx1]");
    expect(graph).toContain("[vx1][v2]xfade=transition=fade:duration=1:offset=18[vj]");
    expect(graph).toContain("[ax1][a2]acrossfade=d=1:c1=tri:c2=tri[aj]");
    expect(graph).toContain("fade=t=out:st=27.4:d=0.6");
    expect(graph).toContain("ass=captions.ass");
    expect(args[args.indexOf("-r") + 1]).toBe("25");
  });

  it("uses fadeblack for a dip to black", () => {
    const { args } = buildConcatArgs({
      clips: inputs([clip(), clip()]),
      settings: { ...fade, transition: "dip" },
      outputPath: "out.mp4",
      subtitlesFile: null,
      fps: 30,
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("xfade=transition=fadeblack");
  });

  it("adds silent audio for clips without a sound track", () => {
    const clips = [clip(), clip({ hasAudio: false, trimEnd: 3 })];
    const { args } = buildConcatArgs({ clips: inputs(clips), settings: cut, outputPath: "out.mp4", subtitlesFile: null, fps: 30 });
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[2:a]aformat");
    expect(graph).toContain("[0:a:0]aformat");
  });

  it("blurs the sides of clips that aren't 16:9, unless black bars are chosen", () => {
    const clips = [clip({ width: 720, height: 1280 })];
    const blur = buildConcatArgs({ clips: inputs(clips), settings: cut, outputPath: "o.mp4", subtitlesFile: null, fps: 30 });
    expect(blur.args.join(" ")).toContain("gblur");
    const black = buildConcatArgs({ clips: inputs(clips), settings: { ...cut, background: "black" }, outputPath: "o.mp4", subtitlesFile: null, fps: 30 });
    expect(black.args.join(" ")).not.toContain("gblur");
    expect(black.args.join(" ")).toContain("color=black");
  });

  it("leaves out fades and loudness normalisation when switched off", () => {
    const { args } = buildConcatArgs({
      clips: inputs([clip()]),
      settings: { ...cut, fadeInOut: false, normalizeAudio: false },
      outputPath: "out.mp4",
      subtitlesFile: null,
      fps: 30,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).not.toContain("fade=");
    expect(graph).not.toContain("loudnorm");
    expect(graph).toContain("[v0]null[vj]");
  });
});

describe("pickFps", () => {
  it("picks the most common standard rate", () => {
    expect(pickFps([{ fps: 23.98 }, { fps: 24 }, { fps: 30 }])).toBe(24);
    expect(pickFps([{ fps: null }])).toBe(30);
  });
});

describe("parseProgressSeconds", () => {
  it("reads the latest out_time_us", () => {
    expect(parseProgressSeconds("frame=10\nout_time_us=1000000\nout_time_us=2500000\nprogress=continue\n")).toBe(2.5);
    expect(parseProgressSeconds("progress=end\n")).toBeNull();
  });
});

describe("chapters", () => {
  it("formats timestamps", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(75.9)).toBe("1:15");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });

  it("lists one chapter per scene starting at 0:00", () => {
    const clips = [clip({ title: "Beach" }), clip({ title: "Map" }), clip({ title: "Treasure" })];
    expect(buildChapters(clips, computeTimeline(clips, cut))).toBe("0:00 Beach\n0:10 Map\n0:20 Treasure");
  });

  it("folds a scene into the previous chapter until that chapter lasts 10 seconds", () => {
    const clips = [clip({ title: "A" }), clip({ title: "B", trimEnd: 4 }), clip({ title: "C" }), clip({ title: "D" })];
    // B is only 4s long, so it keeps C as well (0:10-0:24).
    expect(buildChapters(clips, computeTimeline(clips, cut))).toBe("0:00 A\n0:10 B\n0:24 D");
  });

  it("returns null when YouTube wouldn't show chapters", () => {
    const clips = [clip(), clip()];
    expect(buildChapters(clips, computeTimeline(clips, cut))).toBeNull();
  });

  it("appends chapters after the description", () => {
    expect(descriptionWithChapters("Hello", "0:00 A")).toBe("Hello\n\n0:00 A");
    expect(descriptionWithChapters("", null)).toBe("");
  });
});

describe("videoRenderKey", () => {
  it("changes with trims, order and settings but ignores captions unless burned in", () => {
    const a = clip({ filePath: "a.mp4", captions: [{ start: 0, end: 1, text: "hi" }] });
    const b = clip({ filePath: "b.mp4" });
    const base = videoRenderKey([a, b], cut);
    expect(videoRenderKey([b, a], cut)).not.toBe(base);
    expect(videoRenderKey([{ ...a, trimStart: 1 }, b], cut)).not.toBe(base);
    expect(videoRenderKey([a, b], { ...cut, fadeInOut: false })).not.toBe(base);
    expect(videoRenderKey([{ ...a, captions: [] }, b], cut)).toBe(base);
    expect(videoRenderKey([{ ...a, captions: [] }, b], { ...cut, burnCaptions: true })).not.toBe(videoRenderKey([a, b], { ...cut, burnCaptions: true }));
  });
});

describe("buildLandscapeAss", () => {
  it("writes one dialogue line per cue at 1920×1080", () => {
    const ass = buildLandscapeAss([{ start: 1, end: 2.5, text: "Hello {there}" }]);
    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.50,Caption,,0,0,0,,Hello (there)");
  });
});

describe("evaluateVideoQuality", () => {
  const base = {
    clips: [clip()],
    settings: cut,
    rendered: true,
    renderCurrent: true,
    outputProbe: {
      durationSeconds: 10,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
      sizeBytes: 1,
    },
    outputAudio: { integratedLufs: -14.2, truePeakDbfs: -1.6, loudnessRangeLu: 5, silent: false },
    captionsReviewed: true,
    metadata: { title: "Mila's beach day", description: "A gentle story.", hashtags: [] },
    metadataApproved: true,
    ffmpegAvailable: true,
  };

  it("passes a current, approved render", () => {
    const checks = evaluateVideoQuality(base);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(videoApprovalBlockers(checks, { rendered: true, metadataApproved: true })).toEqual([]);
  });

  it("blocks a stale render, unreviewed burned-in captions and calls to action", () => {
    const checks = evaluateVideoQuality({
      ...base,
      renderCurrent: false,
      settings: { ...cut, burnCaptions: true },
      captionsReviewed: false,
      clips: [clip({ captions: [{ start: 0, end: 2, text: "hi" }] })],
      metadata: { ...base.metadata, description: "Subscribe for more!" },
    });
    const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failed).toEqual(["render", "captions", "metadata"]);
  });

  it("fails clips trimmed to almost nothing", () => {
    const checks = evaluateVideoQuality({ ...base, clips: [clip({ trimStart: 5, trimEnd: 5.2 })] });
    expect(checks.find((c) => c.id === "timeline")?.status).toBe("fail");
  });
});
