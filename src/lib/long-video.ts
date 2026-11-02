import { z } from "zod";

import type { CheckStatus } from "./short-qc";
import { assTime, type AudioLevels, escapeAssText, LOUDNESS_TARGET_LUFS, type MediaProbe } from "./short-video";
import {
  type CaptionCue,
  DESCRIPTION_MAX,
  findMetadataConcerns,
  normalizeHashtags,
  SHORT_STATUSES,
  type ShortStatus,
  TITLE_MAX,
  validateCaptions,
} from "./shorts";

// Pure helpers for the Video Studio: full-length 16:9 videos assembled from a production plan's
// approved scene clips. Shared by the DB schema, server actions and client components.

// Same review and publishing lifecycle as a Short.
export const VIDEO_STATUSES = SHORT_STATUSES;
export type VideoStatus = ShortStatus;

/** Published videos, and videos already uploaded to YouTube, can't be edited. */
export function isVideoLocked(video: { status: VideoStatus; youtubeVideoId: string | null }) {
  return video.status === "published" || video.youtubeVideoId !== null;
}

export const VIDEO_W = 1920;
export const VIDEO_H = 1080;

// ---------- Timeline ----------

/** One scene clip on the timeline. The source file is only read, never changed. */
export type VideoClip = {
  assetId: string;
  sceneId: string | null;
  sceneNumber: number;
  title: string;
  filePath: string;
  /** Length of the source file. */
  sourceSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  trimStart: number;
  /** Null plays the clip to its end. */
  trimEnd: number | null;
  /** Timed against the source clip, so reordering and trimming never shifts them. */
  captions: CaptionCue[];
};

export const TRANSITIONS = ["cut", "crossfade", "dip"] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const TRANSITION_LABELS: Record<Transition, string> = {
  cut: "Hard cut",
  crossfade: "Crossfade",
  dip: "Dip to black",
};

export const editSettingsSchema = z.object({
  transition: z.enum(TRANSITIONS),
  transitionSeconds: z.coerce.number().min(0.2).max(2),
  /** How clips that aren't 16:9 fill the sides: a blurred copy of the picture, or black bars. */
  background: z.enum(["blur", "black"]),
  /** Fade in from and out to black at the very start and end. */
  fadeInOut: z.boolean(),
  burnCaptions: z.boolean(),
  normalizeAudio: z.boolean(),
  /** Adds YouTube chapters (one per scene) to the description. */
  chapters: z.boolean(),
});

export type EditSettings = z.infer<typeof editSettingsSchema>;

export const DEFAULT_EDIT_SETTINGS: EditSettings = {
  transition: "crossfade",
  transitionSeconds: 0.5,
  background: "blur",
  fadeInOut: true,
  // Long videos usually carry captions as a track (the .srt) rather than burned in.
  burnCaptions: false,
  normalizeAudio: true,
  chapters: true,
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function clipLength(clip: Pick<VideoClip, "sourceSeconds" | "trimStart" | "trimEnd">) {
  return round2(Math.max(0, (clip.trimEnd ?? clip.sourceSeconds) - clip.trimStart));
}

/** Shortest clip FFmpeg is asked to handle. */
export const MIN_CLIP_SECONDS = 0.5;

/**
 * Where each clip starts on the final timeline. Transitions overlap neighbouring clips, so each
 * one starts `overlap` seconds before the previous one ends. The overlap is capped at half the
 * shortest clip so a transition never swallows a whole clip.
 */
export function computeTimeline(clips: Pick<VideoClip, "sourceSeconds" | "trimStart" | "trimEnd">[], settings: Pick<EditSettings, "transition" | "transitionSeconds">) {
  const lengths = clips.map(clipLength);
  const shortest = lengths.length ? Math.min(...lengths) : 0;
  const overlap = settings.transition === "cut" || clips.length < 2 ? 0 : round2(Math.min(settings.transitionSeconds, shortest / 2));
  let t = 0;
  const segments = lengths.map((length, i) => {
    const start = round2(t);
    t += length - (i < lengths.length - 1 ? overlap : 0);
    return { start, length };
  });
  return { segments, overlap, total: round2(t) };
}

export type Timeline = ReturnType<typeof computeTimeline>;

/** The clips' captions placed on the final timeline, cut to each clip's trimmed range. */
export function timelineCaptions(clips: VideoClip[], timeline: Timeline): CaptionCue[] {
  const cues: CaptionCue[] = [];
  clips.forEach((clip, i) => {
    const { start, length } = timeline.segments[i];
    const end = clip.trimStart + length;
    for (const cue of clip.captions) {
      if (cue.end <= clip.trimStart || cue.start >= end) continue;
      const from = Math.max(cue.start, clip.trimStart) - clip.trimStart + start;
      const to = Math.min(cue.end, end) - clip.trimStart + start;
      if (to - from >= 0.2) cues.push({ start: round1(from), end: round1(to), text: cue.text });
    }
  });
  return cues.sort((a, b) => a.start - b.start);
}

export function isLandscape169(clip: Pick<VideoClip, "width" | "height">) {
  return Boolean(clip.width && clip.height && Math.abs(clip.width / clip.height - 16 / 9) < 0.02);
}

/** Most common frame rate among the clips, snapped to a standard rate. */
export function pickFps(clips: Pick<VideoClip, "fps">[]) {
  const standard = [24, 25, 30, 50, 60];
  const counts = new Map<number, number>();
  for (const c of clips) {
    if (!c.fps) continue;
    const snapped = standard.reduce((best, r) => (Math.abs(r - c.fps!) < Math.abs(best - c.fps!) ? r : best), 30);
    counts.set(snapped, (counts.get(snapped) ?? 0) + 1);
  }
  let fps = 30;
  let most = 0;
  for (const [rate, n] of counts) {
    if (n > most) {
      fps = rate;
      most = n;
    }
  }
  return fps;
}

/** Everything that changes the rendered file; a render is stale when its key differs. */
export function videoRenderKey(clips: VideoClip[], settings: EditSettings) {
  return JSON.stringify({
    clips: clips.map((c) => [c.filePath, c.trimStart, c.trimEnd, settings.burnCaptions ? c.captions : null]),
    transition: settings.transition === "cut" ? "cut" : [settings.transition, settings.transitionSeconds],
    background: settings.background,
    fade: settings.fadeInOut,
    captions: settings.burnCaptions,
    normalizeAudio: settings.normalizeAudio,
  });
}

// ---------- FFmpeg ----------

const FADE_SECONDS = 0.6;

/**
 * FFmpeg arguments that join the clips into one 1920×1080 file. Every clip is scaled to fit
 * (letterboxed, never cropped), brought to one frame rate and audio format, and given silent audio
 * when it has none, so clips from different models join cleanly.
 */
export function buildConcatArgs(input: {
  clips: (VideoClip & { inputPath: string })[];
  settings: EditSettings;
  outputPath: string;
  subtitlesFile: string | null;
  fps: number;
}) {
  const { clips, settings, fps } = input;
  if (!clips.length) throw new Error("No clips to render");
  const timeline = computeTimeline(clips, settings);
  const args = ["-hide_banner", "-nostdin", "-y"];
  const graph: string[] = [];
  let next = 0;

  clips.forEach((clip, i) => {
    const length = timeline.segments[i].length;
    const video = next++;
    args.push("-ss", String(clip.trimStart), "-t", String(length), "-i", clip.inputPath);
    let audio = `${video}:a:0`;
    if (!clip.hasAudio) {
      audio = `${next++}:a`;
      args.push("-f", "lavfi", "-t", String(length), "-i", "anullsrc=r=48000:cl=stereo");
    }
    const fit = `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=decrease:flags=lanczos`;
    // tpad + trim guarantee the exact length the transition offsets were computed from.
    const finish = `setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=1,trim=duration=${length},setpts=PTS-STARTPTS[v${i}]`;
    if (settings.background === "blur" && !isLandscape169(clip)) {
      graph.push(
        `[${video}:v]split=2[bgsrc${i}][fgsrc${i}]`,
        // The sides are the same picture, blurred and dimmed, so nothing new is invented.
        `[bgsrc${i}]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},gblur=sigma=40,eq=brightness=-0.12:saturation=0.85[bg${i}]`,
        `[fgsrc${i}]${fit}[fg${i}]`,
        `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,${finish}`,
      );
    } else {
      graph.push(`[${video}:v]${fit},pad=${VIDEO_W}:${VIDEO_H}:(ow-iw)/2:(oh-ih)/2:color=black,${finish}`);
    }
    graph.push(
      `[${audio}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `apad=whole_dur=${length},atrim=duration=${length},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });

  if (clips.length === 1) {
    graph.push("[v0]null[vj]", "[a0]anull[aj]");
  } else if (timeline.overlap === 0) {
    graph.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[vj][aj]`);
  } else {
    const kind = settings.transition === "dip" ? "fadeblack" : "fade";
    let v = "v0";
    let a = "a0";
    for (let i = 1; i < clips.length; i++) {
      const last = i === clips.length - 1;
      const vOut = last ? "vj" : `vx${i}`;
      const aOut = last ? "aj" : `ax${i}`;
      graph.push(
        `[${v}][v${i}]xfade=transition=${kind}:duration=${timeline.overlap}:offset=${timeline.segments[i].start}[${vOut}]`,
        `[${a}][a${i}]acrossfade=d=${timeline.overlap}:c1=tri:c2=tri[${aOut}]`,
      );
      v = vOut;
      a = aOut;
    }
  }

  const videoChain: string[] = [];
  const audioChain: string[] = [];
  if (settings.fadeInOut && timeline.total > FADE_SECONDS * 3) {
    const out = round2(timeline.total - FADE_SECONDS);
    videoChain.push(`fade=t=in:st=0:d=${FADE_SECONDS}`, `fade=t=out:st=${out}:d=${FADE_SECONDS}`);
    audioChain.push(`afade=t=in:st=0:d=${FADE_SECONDS}`, `afade=t=out:st=${out}:d=${FADE_SECONDS}`);
  }
  // The subtitle file is passed as a bare name and FFmpeg runs in its folder (see buildFilterGraph).
  if (input.subtitlesFile) videoChain.push(`ass=${input.subtitlesFile}`);
  videoChain.push("format=yuv420p");
  if (settings.normalizeAudio) audioChain.push(`loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11`);
  // loudnorm works at 192 kHz internally.
  audioChain.push("aresample=48000");
  graph.push(`[vj]${videoChain.join(",")}[vout]`, `[aj]${audioChain.join(",")}[aout]`);

  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-r",
    String(fps),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    input.outputPath,
  );
  return { args, durationSeconds: timeline.total };
}

/** Reads `out_time_us` from FFmpeg's `-progress` output; null when the chunk has none. */
export function parseProgressSeconds(chunk: string) {
  const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1]) / 1_000_000;
}

export const LANDSCAPE_CAPTION_FONT_SIZE = 54;

/** Burned-in captions for the 1920×1080 frame. */
export function buildLandscapeAss(cues: CaptionCue[]) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${VIDEO_W}`,
    `PlayResY: ${VIDEO_H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,Arial,${LANDSCAPE_CAPTION_FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,160,160,70,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${escapeAssText(c.text)}`);
  return [...header, ...events, ""].join("\n");
}

// ---------- YouTube chapters ----------

export function formatTimestamp(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const CHAPTER_MIN_SECONDS = 10;
export const CHAPTER_MIN_COUNT = 3;

/**
 * One chapter per scene, in YouTube's format. YouTube only shows chapters when the list starts at
 * 0:00, has at least three entries and each lasts 10 seconds or more, so short scenes are merged
 * into the chapter before them. Null when that still isn't enough for three chapters.
 */
export function buildChapters(clips: Pick<VideoClip, "title">[], timeline: Timeline) {
  const chapters: { start: number; title: string }[] = [];
  timeline.segments.forEach((segment, i) => {
    const previous = chapters[chapters.length - 1];
    if (previous && segment.start - previous.start < CHAPTER_MIN_SECONDS) return;
    chapters.push({ start: i === 0 ? 0 : segment.start, title: clips[i].title.trim() || `Scene ${i + 1}` });
  });
  const last = chapters[chapters.length - 1];
  if (last && timeline.total - last.start < CHAPTER_MIN_SECONDS) chapters.pop();
  if (chapters.length < CHAPTER_MIN_COUNT) return null;
  return chapters.map((c) => `${formatTimestamp(c.start)} ${c.title}`).join("\n");
}

/** Description body with the chapter list appended. Hashtags are added later by buildDescription. */
export function descriptionWithChapters(description: string, chapters: string | null) {
  return [description.trim(), chapters].filter(Boolean).join("\n\n");
}

/** The description uploaded to YouTube: the user's text plus chapters when they're switched on. */
export function uploadDescription(video: { description: string; clips: VideoClip[]; editSettings: EditSettings }) {
  const chapters = video.editSettings.chapters ? buildChapters(video.clips, computeTimeline(video.clips, video.editSettings)) : null;
  return descriptionWithChapters(video.description, chapters);
}

// ---------- Metadata ----------

const text = (max: number) => z.string().trim().max(max).default("");

export const videoMetadataSchema = z.object({
  title: z.string().trim().min(1, "Give the video a title").max(TITLE_MAX, `YouTube titles are limited to ${TITLE_MAX} characters`),
  description: text(DESCRIPTION_MAX - 600),
  hashtags: z.string().default("").transform(normalizeHashtags),
  playlist: text(150),
  notes: text(4000),
});

export type VideoMetadataErrors = Partial<Record<keyof z.input<typeof videoMetadataSchema>, string[]>>;
export type VideoMetadataState = { ok: true; message: string } | { ok: false; message?: string; errors?: VideoMetadataErrors } | null;

export function parseVideoMetadataForm(formData: FormData) {
  return videoMetadataSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    hashtags: formData.get("hashtags") ?? "",
    playlist: formData.get("playlist") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export const videoMetadataSuggestionSchema = z.object({
  title: z.string(),
  description: z.string(),
  hashtags: z.array(z.string()),
  playlist: z.string(),
  childSafety: z.object({ status: z.enum(["pass", "concern"]), notes: z.string() }),
});

export type VideoMetadataSuggestion = z.infer<typeof videoMetadataSuggestionSchema>;

// ---------- Quality checks ----------

export type VideoCheck = { id: string; label: string; status: CheckStatus; details: string[] };

export type VideoQualityInput = {
  clips: VideoClip[];
  settings: EditSettings;
  rendered: boolean;
  renderCurrent: boolean;
  outputProbe: MediaProbe | null;
  outputAudio: AudioLevels | null;
  captionsReviewed: boolean;
  metadata: { title: string; description: string; hashtags: string[] };
  metadataApproved: boolean;
  ffmpegAvailable: boolean;
  /** Story-to-video consistency of every clip (script QC + vision check). */
  consistency?: { status: CheckStatus; details: string[] } | null;
};

export function evaluateVideoQuality(input: VideoQualityInput): VideoCheck[] {
  const checks: VideoCheck[] = [];
  const out = input.rendered ? input.outputProbe : null;
  const timeline = computeTimeline(input.clips, input.settings);

  const tooShort = input.clips.filter((c) => clipLength(c) < MIN_CLIP_SECONDS);
  if (!input.clips.length) {
    checks.push({ id: "timeline", label: "Timeline", status: "fail", details: ["Add at least one scene clip."] });
  } else if (tooShort.length) {
    checks.push({
      id: "timeline",
      label: "Timeline",
      status: "fail",
      details: tooShort.map((c) => `Scene ${c.sceneNumber} is trimmed to under ${MIN_CLIP_SECONDS}s.`),
    });
  } else {
    checks.push({
      id: "timeline",
      label: "Timeline",
      status: "pass",
      details: [`${input.clips.length} clip${input.clips.length === 1 ? "" : "s"}, ${formatTimestamp(timeline.total)} in total.`],
    });
  }

  if (!input.rendered) {
    checks.push({
      id: "render",
      label: "16:9 render",
      status: input.ffmpegAvailable ? "fail" : "unavailable",
      details: [input.ffmpegAvailable ? "Not rendered yet." : "FFmpeg isn't installed, so the video can't be rendered. See the README."],
    });
  } else if (!input.renderCurrent) {
    checks.push({ id: "render", label: "16:9 render", status: "fail", details: ["The timeline, captions or settings changed since the last render. Render again."] });
  } else if (out?.width !== VIDEO_W || out?.height !== VIDEO_H) {
    checks.push({ id: "render", label: "16:9 render", status: "fail", details: [`Output is ${out?.width ?? "?"}×${out?.height ?? "?"}, not ${VIDEO_W}×${VIDEO_H}.`] });
  } else {
    checks.push({
      id: "render",
      label: "16:9 render",
      status: "pass",
      details: [`${VIDEO_W}×${VIDEO_H}, ${out.durationSeconds ? formatTimestamp(out.durationSeconds) : "?"}. The original clips are unchanged.`],
    });
  }

  const letterboxed = input.clips.filter((c) => c.width && c.height && !isLandscape169(c));
  const lowRes = input.clips.filter((c) => c.height && c.height < 720);
  if (letterboxed.length || lowRes.length) {
    checks.push({
      id: "sources",
      label: "Source clips",
      status: "warn",
      details: [
        ...letterboxed.map(
          (c) => `Scene ${c.sceneNumber} is ${c.width}×${c.height}, not 16:9: the sides are filled with ${input.settings.background === "blur" ? "a blurred copy" : "black bars"}.`,
        ),
        ...lowRes.map((c) => `Scene ${c.sceneNumber} is only ${c.height}p and will look soft at 1080p.`),
      ],
    });
  } else if (input.clips.length) {
    checks.push({ id: "sources", label: "Source clips", status: "pass", details: ["Every clip is 16:9 and at least 720p."] });
  }

  const silentClips = input.clips.filter((c) => !c.hasAudio);
  const audioDetails: string[] = silentClips.map((c) => `Scene ${c.sceneNumber} has no sound track; silence is added.`);
  let audioStatus: CheckStatus = silentClips.length ? "warn" : "pass";
  if (out && input.outputAudio) {
    const lufs = input.outputAudio.integratedLufs;
    if (input.outputAudio.silent) {
      audioStatus = "warn";
      audioDetails.push("The render is silent.");
    } else if (lufs !== null) {
      audioDetails.push(`Loudness ${round1(lufs)} LUFS (YouTube target about ${LOUDNESS_TARGET_LUFS}).`);
      if (Math.abs(lufs - LOUDNESS_TARGET_LUFS) > 3) audioStatus = "warn";
    }
  } else if (!out) {
    audioDetails.push("Measured after rendering.");
    if (!silentClips.length) audioStatus = "unavailable";
  }
  checks.push({ id: "audio", label: "Sound", status: audioStatus, details: audioDetails });

  const allCaptions = input.clips.flatMap((c) => c.captions);
  const captionIssues = input.clips.flatMap((c) =>
    validateCaptions(c.captions, c.sourceSeconds).map((issue) => ({ ...issue, message: `Scene ${c.sceneNumber}: ${issue.message}` })),
  );
  if (!allCaptions.length) {
    checks.push({ id: "captions", label: "Captions", status: "pass", details: ["No captions. Add them per clip if the scenes have dialogue."] });
  } else if (captionIssues.some((i) => i.level === "fail")) {
    checks.push({ id: "captions", label: "Captions", status: "fail", details: captionIssues.map((i) => i.message).slice(0, 4) });
  } else if (input.settings.burnCaptions && !input.captionsReviewed) {
    checks.push({ id: "captions", label: "Captions", status: "fail", details: ["Captions are burned in: play the render and confirm they match the audio."] });
  } else {
    checks.push({
      id: "captions",
      label: "Captions",
      status: captionIssues.length || !input.captionsReviewed ? "warn" : "pass",
      details: [
        ...captionIssues.map((i) => i.message).slice(0, 3),
        input.settings.burnCaptions ? "Burned into the picture." : "Not burned in: upload the .srt as a caption track in YouTube Studio.",
        ...(input.captionsReviewed ? [] : ["Not marked as checked against the audio yet."]),
      ],
    });
  }

  if (input.consistency) {
    checks.push({ id: "consistency", label: "Story consistency", status: input.consistency.status, details: input.consistency.details });
  }

  const concerns = findMetadataConcerns({ ...input.metadata, hook: "" });
  if (concerns.length) {
    checks.push({ id: "metadata", label: "Metadata", status: "fail", details: concerns });
  } else if (!input.metadata.description.trim()) {
    checks.push({ id: "metadata", label: "Metadata", status: "warn", details: ["Add a description for parents."] });
  } else {
    checks.push({ id: "metadata", label: "Metadata", status: "pass", details: [input.metadataApproved ? "Approved." : "Not approved yet."] });
  }

  if (input.settings.chapters && input.clips.length) {
    const chapters = buildChapters(input.clips, timeline);
    checks.push({
      id: "chapters",
      label: "Chapters",
      status: chapters ? "pass" : "warn",
      details: [
        chapters
          ? `${chapters.split("\n").length} chapters are added to the description.`
          : `YouTube needs ${CHAPTER_MIN_COUNT}+ chapters of ${CHAPTER_MIN_SECONDS}s or more; this timeline has too few, so none are added.`,
      ],
    });
  }
  return checks;
}

export function summarizeVideoQuality(checks: VideoCheck[]) {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  return { pass: count("pass"), warn: count("warn"), fail: count("fail"), unavailable: count("unavailable") };
}

/** Why a video can't be approved yet; empty when it can. */
export function videoApprovalBlockers(checks: VideoCheck[], input: { rendered: boolean; metadataApproved: boolean }) {
  const blockers: string[] = [];
  if (!input.rendered) blockers.push("Render the 16:9 video first.");
  if (!input.metadataApproved) blockers.push("Approve the metadata first.");
  for (const c of checks) if (c.status === "fail") blockers.push(`${c.label}: ${c.details[0] ?? "failed"}`);
  return [...new Set(blockers)];
}
