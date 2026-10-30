import { describe, expect, it } from "vitest";

import {
  aspectLabel,
  buildAssFile,
  buildFilterGraph,
  buildRenderArgs,
  computeFraming,
  escapeAssText,
  isVertical916,
  parseLoudness,
  parseProbe,
} from "./short-video";

const settings = { zoom: 1, focusX: 50, focusY: 50 };

describe("computeFraming", () => {
  it("keeps the whole 16:9 frame at zoom 1", () => {
    const f = computeFraming(1280, 720, settings);
    expect(f).toMatchObject({ scaledW: 1080, scaledH: 608, visibleW: 1080, visibleH: 608, cropX: 0, cropY: 0, offsetX: 0, offsetY: 656, fillsFrame: false });
    expect(f.croppedFraction).toBe(0);
    expect(f.maxZoom).toBeCloseTo(3.16, 2);
  });

  it("fills the frame at max zoom and crops around the focus point", () => {
    const center = computeFraming(1280, 720, { ...settings, zoom: 10 });
    expect(center.fillsFrame).toBe(true);
    expect(center.visibleW).toBe(1080);
    expect(center.visibleH).toBe(1920);
    expect(center.croppedFraction).toBeGreaterThan(0.6);
    const left = computeFraming(1280, 720, { ...settings, zoom: 10, focusX: 0 });
    const right = computeFraming(1280, 720, { ...settings, zoom: 10, focusX: 100 });
    expect(left.cropX).toBe(0);
    expect(right.cropX).toBe(right.scaledW - 1080);
    expect(center.cropX).toBeGreaterThan(left.cropX);
    expect(center.cropX % 2).toBe(0);
  });

  it("treats a 9:16 source as already filling the frame", () => {
    const f = computeFraming(720, 1280, settings);
    expect(f.fillsFrame).toBe(true);
    expect(f.croppedFraction).toBe(0);
    expect(f.scale).toBeCloseTo(1.5);
  });
});

describe("FFmpeg command", () => {
  it("letterboxes on a blurred copy and burns in subtitles", () => {
    const graph = buildFilterGraph(computeFraming(1280, 720, settings), "overlay.ass");
    expect(graph).toContain("split=2[bgsrc][fgsrc]");
    expect(graph).toContain("gblur");
    expect(graph).toContain("overlay=0:656");
    expect(graph).toContain("[base]ass=overlay.ass,format=yuv420p[v]");
  });

  it("skips the background when the picture fills the frame", () => {
    const graph = buildFilterGraph(computeFraming(1280, 720, { ...settings, zoom: 10 }), null);
    expect(graph).not.toContain("gblur");
    expect(graph).toContain("crop=1080:1920:");
    expect(graph.endsWith("[base]format=yuv420p[v]")).toBe(true);
  });

  it("writes to the output path only and normalises loudness on request", () => {
    const args = buildRenderArgs({
      inputPath: "C:/media/scenes/a/clip.mp4",
      outputPath: "C:/media/shorts/b/out.mp4",
      framing: computeFraming(1280, 720, settings),
      subtitlesFile: null,
      normalizeAudio: true,
    });
    expect(args[args.indexOf("-i") + 1]).toBe("C:/media/scenes/a/clip.mp4");
    expect(args.at(-1)).toBe("C:/media/shorts/b/out.mp4");
    expect(args).toContain("0:a:0?");
    expect(args[args.indexOf("-af") + 1]).toMatch(/^loudnorm=I=-14/);
    const quiet = buildRenderArgs({ inputPath: "a", outputPath: "b", framing: computeFraming(1280, 720, settings), subtitlesFile: null, normalizeAudio: false });
    expect(quiet).not.toContain("-af");
  });
});

describe("ASS subtitles", () => {
  it("escapes override braces and line breaks", () => {
    expect(escapeAssText("Hi {there}\nfriend \\N")).toBe("Hi (there)\\Nfriend /N");
  });

  it("contains the hook and timed captions", () => {
    const ass = buildAssFile({
      cues: [{ start: 1.5, end: 3.25, text: "A rectangle!" }],
      hook: "Can Mila make a rocket?",
      hookSeconds: 2.5,
      framing: computeFraming(1280, 720, settings),
    });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Dialogue: 1,0:00:00.00,0:00:02.50,Hook,,0,0,0,,{\\fad(150,300)}Can Mila make a rocket?");
    expect(ass).toContain("Dialogue: 0,0:00:01.50,0:00:03.25,Caption,,0,0,0,,A rectangle!");
  });
});

describe("probe parsing", () => {
  it("reads video and audio streams", () => {
    const probe = parseProbe(
      JSON.stringify({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1280, height: 720, avg_frame_rate: "24/1" },
          { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
        ],
        format: { duration: "15.041667", size: "5242880" },
      }),
    );
    expect(probe).toEqual({
      durationSeconds: 15.04,
      width: 1280,
      height: 720,
      fps: 24,
      videoCodec: "h264",
      hasAudio: true,
      audioCodec: "aac",
      sampleRate: 48000,
      channels: 2,
      sizeBytes: 5242880,
    });
  });

  it("swaps dimensions for rotated phone videos and handles no audio", () => {
    const probe = parseProbe(
      JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: {} }),
    );
    expect([probe.width, probe.height, probe.hasAudio, probe.durationSeconds]).toEqual([1080, 1920, false, null]);
  });

  it("labels aspect ratios", () => {
    expect(aspectLabel(1280, 720)).toBe("16:9");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
    expect(isVertical916(1080, 1920)).toBe(true);
    expect(isVertical916(1280, 720)).toBe(false);
  });
});

describe("loudness parsing", () => {
  const summary = `[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -16.4 LUFS
    Threshold: -26.7 LUFS

  Loudness range:
    LRA:         4.1 LU
    Threshold: -36.8 LUFS

  True peak:
    Peak:       -1.2 dBFS`;

  it("reads the ebur128 summary", () => {
    expect(parseLoudness(`frame lines...\n${summary}`)).toEqual({ integratedLufs: -16.4, truePeakDbfs: -1.2, loudnessRangeLu: 4.1, silent: false });
  });

  it("detects silence and missing output", () => {
    expect(parseLoudness(summary.replace("-16.4 LUFS", "-inf LUFS"))?.silent).toBe(true);
    expect(parseLoudness("no summary here")).toBeNull();
  });
});
