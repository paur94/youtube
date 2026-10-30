import type { CaptionCue, VideoSettings } from "./shorts";

// Pure helpers for the vertical render: framing geometry (also used by the browser preview),
// the FFmpeg command line, the burned-in caption file, and parsing FFmpeg/ffprobe output.

export const OUT_W = 1080;
export const OUT_H = 1920;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const evenFloor = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export type Framing = {
  /** Zoom actually applied (clamped to what the source allows). */
  zoom: number;
  /** Zoom at which the source fills the whole 9:16 frame. */
  maxZoom: number;
  /** Size of the scaled source before cropping. */
  scaledW: number;
  scaledH: number;
  /** Visible part of the scaled source and where it is cut from. */
  visibleW: number;
  visibleH: number;
  cropX: number;
  cropY: number;
  /** Where the visible part sits in the 1080×1920 frame. */
  offsetX: number;
  offsetY: number;
  /** Blurred background (cover-scaled source), unused when the source fills the frame. */
  backgroundW: number;
  backgroundH: number;
  fillsFrame: boolean;
  /** Share of the original picture that is cut off (0 = nothing cropped). */
  croppedFraction: number;
  /** Source pixels are enlarged by this factor (>1 means upscaling). */
  scale: number;
};

export function computeFraming(sourceW: number, sourceH: number, settings: Pick<VideoSettings, "zoom" | "focusX" | "focusY">): Framing {
  const fit = Math.min(OUT_W / sourceW, OUT_H / sourceH);
  const cover = Math.max(OUT_W / sourceW, OUT_H / sourceH);
  const maxZoom = cover / fit;
  const zoom = clamp(settings.zoom, 1, maxZoom);
  const scale = fit * zoom;

  const scaledW = even(sourceW * scale);
  const scaledH = even(sourceH * scale);
  const visibleW = Math.min(scaledW, OUT_W);
  const visibleH = Math.min(scaledH, OUT_H);
  const cropX = evenFloor(((scaledW - visibleW) * clamp(settings.focusX, 0, 100)) / 100);
  const cropY = evenFloor(((scaledH - visibleH) * clamp(settings.focusY, 0, 100)) / 100);
  return {
    zoom,
    maxZoom,
    scaledW,
    scaledH,
    visibleW,
    visibleH,
    cropX: Math.min(cropX, scaledW - visibleW),
    cropY: Math.min(cropY, scaledH - visibleH),
    offsetX: Math.round((OUT_W - visibleW) / 2),
    offsetY: Math.round((OUT_H - visibleH) / 2),
    backgroundW: even(sourceW * cover),
    backgroundH: even(sourceH * cover),
    fillsFrame: visibleW >= OUT_W && visibleH >= OUT_H,
    croppedFraction: Math.max(0, 1 - (visibleW * visibleH) / (scaledW * scaledH)),
    scale,
  };
}

export function buildFilterGraph(framing: Framing, subtitlesFile: string | null) {
  const f = framing;
  const crop = `crop=${f.visibleW}:${f.visibleH}:${f.cropX}:${f.cropY}`;
  const parts = f.fillsFrame
    ? [`[0:v]scale=${f.scaledW}:${f.scaledH}:flags=lanczos,${crop},setsar=1[base]`]
    : [
        "[0:v]split=2[bgsrc][fgsrc]",
        // The background is the same picture, blurred and dimmed, so nothing new is invented.
        `[bgsrc]scale=${f.backgroundW}:${f.backgroundH},crop=${OUT_W}:${OUT_H},gblur=sigma=40,eq=brightness=-0.12:saturation=0.85[bg]`,
        `[fgsrc]scale=${f.scaledW}:${f.scaledH}:flags=lanczos,${crop}[fg]`,
        `[bg][fg]overlay=${f.offsetX}:${f.offsetY},setsar=1[base]`,
      ];
  // The subtitle file is passed as a bare name and FFmpeg runs in its folder, which avoids
  // escaping Windows drive letters inside the filter graph.
  parts.push(subtitlesFile ? `[base]ass=${subtitlesFile},format=yuv420p[v]` : "[base]format=yuv420p[v]");
  return parts.join(";");
}

/** YouTube's recommended loudness target is about -14 LUFS. */
export const LOUDNESS_TARGET_LUFS = -14;

export function buildRenderArgs(input: {
  inputPath: string;
  outputPath: string;
  framing: Framing;
  subtitlesFile: string | null;
  normalizeAudio: boolean;
}) {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input.inputPath,
    "-filter_complex",
    buildFilterGraph(input.framing, input.subtitlesFile),
    "-map",
    "[v]",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-profile:v",
    "high",
    ...(input.normalizeAudio ? ["-af", `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11`] : []),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    input.outputPath,
  ];
}

// ---------- Burned-in captions and hook (ASS subtitles) ----------

function assTime(seconds: number) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

/** Override blocks start with `{` and line breaks are `\N`, so user text must not contain them raw. */
export function escapeAssText(text: string) {
  return text.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}

export const CAPTION_FONT_SIZE = 68;
export const HOOK_FONT_SIZE = 84;

/**
 * Distance of the captions from the bottom and of the hook from the top (1080×1920 units).
 * Captions sit in the lower blurred band when there is one, clear of YouTube's Shorts controls.
 */
export function overlayMargins(framing: Framing) {
  const lowerBand = OUT_H - (framing.offsetY + framing.visibleH);
  return {
    captionMargin: framing.fillsFrame || lowerBand < 300 ? 420 : Math.max(380, Math.round(lowerBand * 0.45)),
    hookMargin: framing.fillsFrame || framing.offsetY < 300 ? 260 : Math.max(220, Math.round(framing.offsetY * 0.4)),
  };
}

export function buildAssFile(input: {
  cues: CaptionCue[];
  hook: string | null;
  hookSeconds: number;
  framing: Framing;
}) {
  const { captionMargin, hookMargin } = overlayMargins(input.framing);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,Arial,${CAPTION_FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,90,90,${captionMargin},1`,
    `Style: Hook,Arial,${HOOK_FONT_SIZE},&H0000E1FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,3,8,80,80,${hookMargin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const hook = input.hook?.trim();
  if (hook) {
    events.push(`Dialogue: 1,${assTime(0)},${assTime(input.hookSeconds)},Hook,,0,0,0,,{\\fad(150,300)}${escapeAssText(hook)}`);
  }
  for (const cue of input.cues) {
    events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,${escapeAssText(cue.text)}`);
  }
  return [...header, ...events, ""].join("\n");
}

// ---------- ffprobe / FFmpeg output ----------

export type MediaProbe = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  hasAudio: boolean;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  sizeBytes: number | null;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
};

function rate(value: string | undefined) {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : null;
}

/** Parses `ffprobe -print_format json -show_format -show_streams`. */
export function parseProbe(json: string): MediaProbe {
  const data = JSON.parse(json) as { streams?: ProbeStream[]; format?: { duration?: string; size?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0));
  const swap = rotation === 90 || rotation === 270;
  const duration = Number(data.format?.duration ?? video?.duration);
  const size = Number(data.format?.size);
  return {
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : null,
    width: (swap ? video?.height : video?.width) ?? null,
    height: (swap ? video?.width : video?.height) ?? null,
    fps: rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
    sizeBytes: Number.isFinite(size) ? size : null,
  };
}

export type AudioLevels = {
  /** Integrated loudness (EBU R128). -Infinity is stored as null with `silent`. */
  integratedLufs: number | null;
  truePeakDbfs: number | null;
  loudnessRangeLu: number | null;
  silent: boolean;
};

/** Parses the summary that FFmpeg's `ebur128=peak=true` filter prints to stderr. */
export function parseLoudness(stderr: string): AudioLevels | null {
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  if (!stderr.includes("Summary:")) return null;
  const num = (re: RegExp) => {
    const m = re.exec(summary);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const integrated = num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  const silent = /I:\s+-inf/.test(summary) || (integrated !== null && integrated < -60);
  return {
    integratedLufs: integrated,
    truePeakDbfs: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/),
    loudnessRangeLu: num(/LRA:\s+(-?[\d.]+)\s+LU/),
    silent,
  };
}

export function aspectLabel(width: number | null, height: number | null) {
  if (!width || !height) return "unknown";
  const r = width / height;
  const known: [string, number][] = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
  ];
  const match = known.find(([, v]) => Math.abs(v - r) < 0.02);
  return match ? match[0] : `${width}:${height}`;
}

export function isVertical916(width: number | null, height: number | null) {
  return Boolean(width && height && Math.abs(width / height - 9 / 16) < 0.01);
}
