import { buildOverlayGraph, type OverlayPlacement } from "./overlays";
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

/** `overlays`: steps from buildOverlayGraph that draw scene overlays over `[base]`, below the captions. */
export function buildFilterGraph(framing: Framing, subtitlesFile: string | null, overlays?: { graph: string[]; output: string }) {
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
  const framed = overlays ? overlays.output : "base";
  if (overlays) parts.push(...overlays.graph);
  // The subtitle file is passed as a bare name and FFmpeg runs in its folder, which avoids
  // escaping Windows drive letters inside the filter graph.
  parts.push(subtitlesFile ? `[${framed}]ass=${subtitlesFile},format=yuv420p[v]` : `[${framed}]format=yuv420p[v]`);
  return parts.join(";");
}

/** YouTube's recommended loudness target is about -14 LUFS. */
export const LOUDNESS_TARGET_LUFS = -14;

const LOUDNORM = `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11`;
const STEREO = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
const MUSIC_FADE_IN = 0.5;
const MUSIC_FADE_OUT = 1.5;

export type AudioEdit = {
  /** Drop the clip's own sound. */
  muteOriginal: boolean;
  sourceHasAudio: boolean;
  /** Looped or cut to the clip's length, faded in and out. */
  music: { inputPath: string; volume: number; duck: boolean } | null;
  durationSeconds: number;
};

/**
 * Audio steps for the filter graph, ending in `[a]`, or null when the clip has no sound left.
 * `musicInput` is the music file's input index.
 */
export function buildAudioGraph(audio: AudioEdit, musicInput: number, normalize: boolean) {
  const keep = audio.sourceHasAudio && !audio.muteOriginal;
  const finish = normalize ? LOUDNORM : "alimiter=limit=0.95";
  if (!audio.music) return keep ? [`[0:a:0]${STEREO},${finish}[a]`] : null;

  const d = audio.durationSeconds;
  const fadeOut = Math.max(0, Math.round((d - MUSIC_FADE_OUT) * 1000) / 1000);
  const parts = [
    `[${musicInput}:a]${STEREO},volume=${audio.music.volume},atrim=duration=${d},asetpts=PTS-STARTPTS,` +
      `afade=t=in:d=${MUSIC_FADE_IN},afade=t=out:st=${fadeOut}:d=${MUSIC_FADE_OUT}[music]`,
  ];
  if (!keep) {
    parts.push(`[music]${finish}[a]`);
    return parts;
  }
  if (audio.music.duck) {
    // The clip's own sound drives a compressor on the music, so it dips whenever someone speaks.
    parts.push(
      `[0:a:0]${STEREO},asplit=2[orig][key]`,
      "[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[bed]",
    );
  } else {
    parts.push(`[0:a:0]${STEREO}[orig]`, "[music]anull[bed]");
  }
  parts.push(`[orig][bed]amix=inputs=2:duration=first:normalize=0,${finish}[a]`);
  return parts;
}

export function buildRenderArgs(input: {
  inputPath: string;
  outputPath: string;
  framing: Framing;
  subtitlesFile: string | null;
  normalizeAudio: boolean;
  /** Overlay images placed in the 1080×1920 frame; they need the source's length and frame rate. */
  overlays?: { placements: OverlayPlacement[]; durationSeconds: number; fps: number };
  /** Muting and background music. Without it the clip's sound is copied through as before. */
  audio?: AudioEdit;
}) {
  const overlays = input.overlays?.placements.length
    ? buildOverlayGraph({ ...input.overlays, overlays: input.overlays.placements, firstInput: 1, from: "base" })
    : undefined;
  const edited = input.audio && (input.audio.muteOriginal || input.audio.music);
  const musicInput = 1 + (overlays?.args.filter((a) => a === "-i").length ?? 0);
  const audioGraph = edited ? buildAudioGraph(input.audio!, musicInput, input.normalizeAudio) : null;
  const video = buildFilterGraph(input.framing, input.subtitlesFile, overlays);
  const audioMap = !edited
    ? ["-map", "0:a:0?", ...(input.normalizeAudio ? ["-af", LOUDNORM] : [])]
    : audioGraph
      ? ["-map", "[a]"]
      : ["-an"];
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input.inputPath,
    ...(overlays?.args ?? []),
    // Looped so a short track still covers the whole clip; the graph cuts it to length.
    ...(edited && input.audio!.music ? ["-stream_loop", "-1", "-i", input.audio!.music.inputPath] : []),
    "-filter_complex",
    audioGraph ? [video, ...audioGraph].join(";") : video,
    "-map",
    "[v]",
    ...audioMap,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-profile:v",
    "high",
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

/**
 * Joins scene clips back to back (hard cuts) into one source for a merged Short. Every clip is
 * fitted into the first clip's frame size and padded to its exact length, so caption offsets
 * computed from the probed lengths stay in sync. Encoded near-losslessly: the vertical render
 * encodes it again.
 */
export function buildJoinArgs(input: {
  clips: { inputPath: string; durationSeconds: number; hasAudio: boolean }[];
  width: number;
  height: number;
  fps: number;
  outputPath: string;
}) {
  if (input.clips.length < 2) throw new Error("Join at least two clips");
  const w = even(input.width);
  const h = even(input.height);
  const args = ["-hide_banner", "-nostdin", "-y"];
  const graph: string[] = [];
  let next = 0;
  input.clips.forEach((clip, i) => {
    const length = clip.durationSeconds;
    const video = next++;
    args.push("-t", String(length), "-i", clip.inputPath);
    let audio = `${video}:a:0`;
    if (!clip.hasAudio) {
      audio = `${next++}:a`;
      args.push("-f", "lavfi", "-t", String(length), "-i", "anullsrc=r=48000:cl=stereo");
    }
    graph.push(
      `[${video}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=${input.fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${length},setpts=PTS-STARTPTS[v${i}]`,
      `[${audio}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `apad=whole_dur=${length},atrim=duration=${length},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });
  graph.push(`${input.clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${input.clips.length}:v=1:a=1[v][a]`);
  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "14",
    "-r",
    String(input.fps),
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    input.outputPath,
  );
  return args;
}

// ---------- Burned-in captions and hook (ASS subtitles) ----------

export function assTime(seconds: number) {
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
