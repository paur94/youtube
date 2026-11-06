import { z } from "zod";

// Scene text overlays (chat bubbles, captions) are stored as data and burned in during Final
// assembly. They are never sent to image or video models, which draw text as gibberish. Shared by
// the scene form, the asset preview and the FFmpeg render, so all three lay text out the same way.

export const OVERLAY_TYPES = ["bubble", "caption"] as const;
export const OVERLAY_POSITIONS = ["top-left", "top-right", "top-center", "bottom-center"] as const;

export type OverlayType = (typeof OVERLAY_TYPES)[number];
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];

export const OVERLAY_TYPE_LABELS: Record<OverlayType, string> = { bubble: "Chat bubble", caption: "Caption" };
export const OVERLAY_POSITION_LABELS: Record<OverlayPosition, string> = {
  "top-left": "Top left",
  "top-right": "Top right",
  "top-center": "Top centre",
  "bottom-center": "Bottom centre",
};

export type SceneOverlay = {
  id: string;
  type: OverlayType;
  text: string;
  position: OverlayPosition;
  /** Seconds, relative to the scene clip. */
  start: number;
  end: number;
  /** Seconds; DEFAULT_OVERLAY_FADE when absent. */
  fadeIn?: number;
  fadeOut?: number;
};

export const DEFAULT_OVERLAY_FADE = 0.4;
export const OVERLAY_TEXT_MAX = 80;
export const MAX_OVERLAYS = 20;

const seconds = z.number("Enter start and end times in seconds");

// Shape only; the rules that need the scene's duration (and the overlay's number for the message)
// are in validateOverlays.
export const sceneOverlaySchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.enum(OVERLAY_TYPES),
  text: z.string().trim().max(500),
  position: z.enum(OVERLAY_POSITIONS),
  start: seconds,
  end: seconds,
  fadeIn: z.number().min(0).max(5).optional(),
  fadeOut: z.number().min(0).max(5).optional(),
});

/** Problems with a scene's overlays, one message each; empty when they're all valid. */
export function validateOverlays(overlays: SceneOverlay[], durationSeconds: number) {
  const problems: string[] = [];
  if (overlays.length > MAX_OVERLAYS) problems.push(`Use at most ${MAX_OVERLAYS} overlays per scene`);
  overlays.forEach((o, i) => {
    const label = `Overlay ${i + 1}`;
    if (!o.text.trim()) problems.push(`${label}: add the text`);
    else if (o.text.trim().length > OVERLAY_TEXT_MAX) problems.push(`${label}: keep the text under ${OVERLAY_TEXT_MAX} characters`);
    if (o.start < 0) problems.push(`${label}: the start can't be negative`);
    if (o.end <= o.start) problems.push(`${label}: the end must be after the start`);
    else if (o.end > durationSeconds) problems.push(`${label}: the end is after the scene ends (${durationSeconds}s)`);
  });
  return problems;
}

/** Reads overlays stored on a scene, dropping anything malformed. */
export function readOverlays(value: unknown): SceneOverlay[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = sceneOverlaySchema.safeParse(item);
    return parsed.success && parsed.data.text ? [parsed.data] : [];
  });
}

// ---------- Timing ----------

/** Fade lengths, shortened so fade-in and fade-out together never exceed the overlay. */
export function overlayFades(overlay: Pick<SceneOverlay, "start" | "end" | "fadeIn" | "fadeOut">) {
  const length = Math.max(0, overlay.end - overlay.start);
  const fadeIn = overlay.fadeIn ?? DEFAULT_OVERLAY_FADE;
  const fadeOut = overlay.fadeOut ?? DEFAULT_OVERLAY_FADE;
  const scale = fadeIn + fadeOut > length ? length / (fadeIn + fadeOut || 1) : 1;
  return { fadeIn: round3(fadeIn * scale), fadeOut: round3(fadeOut * scale) };
}

/** 0 (hidden) to 1 (fully shown) at time `t` of the clip, matching the FFmpeg fades. */
export function overlayOpacityAt(overlay: SceneOverlay, t: number) {
  if (t < overlay.start || t > overlay.end) return 0;
  const { fadeIn, fadeOut } = overlayFades(overlay);
  if (fadeIn && t < overlay.start + fadeIn) return (t - overlay.start) / fadeIn;
  if (fadeOut && t > overlay.end - fadeOut) return (overlay.end - t) / fadeOut;
  return 1;
}

// ---------- Layout ----------

export type Frame = { width: number; height: number };

export type OverlayLayout = {
  fontSize: number;
  lineHeight: number;
  lines: string[];
  paddingY: number;
  /** The rounded box. */
  boxWidth: number;
  boxHeight: number;
  radius: number;
  /** Bubble tail below the box (zero for captions): base from tailFrom to tailTo, tip at tailTip. */
  tailHeight: number;
  tailFrom: number;
  tailTo: number;
  tailTip: number;
  /** The whole image (box plus tail) and its top-left corner in the frame. */
  width: number;
  height: number;
  x: number;
  y: number;
};

// Approximate advance widths of the bundled rounded font, in ems. Text is centred in its box, so
// an estimate that is slightly off only changes the padding.
function charWidth(ch: string) {
  if (ch === " ") return 0.3;
  if (/[il.,:;'!|]/.test(ch)) return 0.3;
  if (/[fjrt()\[\]"]/.test(ch)) return 0.42;
  if (/[mwMW@]/.test(ch)) return 0.9;
  if (/[A-Z0-9]/.test(ch)) return 0.68;
  return 0.58;
}

export function textWidth(text: string, fontSize: number) {
  let em = 0;
  for (const ch of text) em += charWidth(ch);
  return em * fontSize;
}

/** Greedy word wrap to `maxWidth` pixels; a single word wider than that keeps its own line. */
export function wrapText(text: string, fontSize: number, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Size and place an overlay in a frame, in that frame's pixels. Text scales with the frame height
 * (54px on a 1920×1080 frame, 61px on 1080×1920) and the image sits about 6% of the frame away from
 * the chosen edges.
 */
export function overlayLayout(overlay: Pick<SceneOverlay, "type" | "text" | "position">, frame: Frame): OverlayLayout {
  const { width: W, height: H } = frame;
  const landscape = W >= H;
  const bubble = overlay.type === "bubble";
  const fontSize = Math.max(12, Math.round(H * (landscape ? 0.05 : 0.032)));
  const lineHeight = Math.round(fontSize * 1.3);
  const paddingX = Math.round(fontSize * 0.8);
  const paddingY = Math.round(fontSize * 0.5);
  const maxText = W * (bubble ? (landscape ? 0.42 : 0.72) : landscape ? 0.7 : 0.84) - 2 * paddingX;
  const lines = wrapText(overlay.text, fontSize, maxText);
  const longest = Math.max(fontSize, ...lines.map((l) => textWidth(l, fontSize)));

  const boxWidth = Math.min(W, Math.round(longest + 2 * paddingX));
  const boxHeight = lines.length * lineHeight + 2 * paddingY;
  const radius = Math.min(Math.round(fontSize * (bubble ? 0.9 : 0.45)), Math.floor(boxHeight / 2));
  const tailHeight = bubble ? Math.round(fontSize * 0.55) : 0;
  const tailWidth = Math.round(fontSize * 0.75);
  // The tail sits near the side the bubble is anchored to and leans towards that edge.
  let tailFrom: number;
  let tailTip: number;
  if (overlay.position === "top-left") {
    tailFrom = Math.max(radius, Math.round(boxWidth * 0.18));
    tailTip = tailFrom - Math.round(tailWidth * 0.3);
  } else if (overlay.position === "top-right") {
    tailFrom = Math.min(boxWidth - radius, Math.round(boxWidth * 0.82)) - tailWidth;
    tailTip = tailFrom + tailWidth + Math.round(tailWidth * 0.3);
  } else {
    tailFrom = Math.round((boxWidth - tailWidth) / 2);
    tailTip = Math.round(boxWidth / 2);
  }

  const width = boxWidth;
  const height = boxHeight + tailHeight;
  const marginX = Math.round(W * 0.06);
  const marginY = Math.round(H * 0.06);
  const x =
    overlay.position === "top-left" ? marginX : overlay.position === "top-right" ? W - marginX - width : Math.round((W - width) / 2);
  const y = overlay.position === "bottom-center" ? H - marginY - height : marginY;
  return {
    fontSize,
    lineHeight,
    lines,
    paddingY,
    boxWidth,
    boxHeight,
    radius,
    tailHeight,
    tailFrom,
    tailTo: tailFrom + tailWidth,
    tailTip,
    width,
    height,
    x: Math.max(0, x),
    y: Math.max(0, y),
  };
}

export const OVERLAY_STYLE: Record<OverlayType, { fill: string; alpha: number; text: string }> = {
  bubble: { fill: "#ffffff", alpha: 1, text: "#26263a" },
  caption: { fill: "#000000", alpha: 0.6, text: "#ffffff" },
};

// ---------- FFmpeg ----------

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// Drawn at twice the size and scaled down, so the rounded edges are antialiased.
const SUPERSAMPLE = 2;

/**
 * FFmpeg arguments that draw one overlay (rounded box, bubble tail and text) into a transparent PNG.
 * FFmpeg runs in a work folder that holds the font and one text file per line, passed by bare name
 * like the subtitle files, so Windows drive letters never need escaping inside the filter graph.
 */
export function buildOverlayImageArgs(input: {
  type: OverlayType;
  layout: OverlayLayout;
  fontFile: string;
  lineFiles: string[];
  outputPath: string;
}) {
  const s = SUPERSAMPLE;
  const L = input.layout;
  const [W, H, BW, BH, R, TH] = [L.width, L.height, L.boxWidth, L.boxHeight, L.radius, L.tailHeight].map((n) => n * s);
  const [X0, X1, AX] = [L.tailFrom, L.tailTo, L.tailTip].map((n) => n * s);
  // Inside the rounded box: distance to the nearest point of the inner rectangle is at most R.
  const box = `lte(hypot(max(max(${R}-X,X-(${BW}-${R})),0),max(max(${R}-Y,Y-(${BH}-${R})),0)),${R})`;
  // Inside the tail: between its two edges, from the box's bottom edge down to the tip.
  const tail = TH
    ? `between(Y,${BH - 1},${BH + TH})*gte(X,${X0}+(${AX}-${X0})*(Y-${BH})/${TH})*lte(X,${X1}+(${AX}-${X1})*(Y-${BH})/${TH})`
    : "0";
  const style = OVERLAY_STYLE[input.type];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(style.fill.slice(i, i + 2), 16));
  const alpha = Math.round(255 * style.alpha);
  const text = `0x${style.text.slice(1)}`;
  const lines = input.lineFiles.map((file, i) => {
    const top = L.paddingY + i * L.lineHeight;
    return (
      `drawtext=fontfile=${input.fontFile}:textfile=${file}:expansion=none:fontsize=${L.fontSize}:fontcolor=${text}` +
      `:y_align=font:x=(w-text_w)/2:y=${top}+(${L.lineHeight}-(ascent-descent))/2`
    );
  });
  const filter = [
    "format=rgba",
    `geq=r='${r}':g='${g}':b='${b}':a='${alpha}*max(${box},${tail})'`,
    `scale=${L.width}:${L.height}:flags=area`,
    ...lines,
  ].join(",");
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=black@0:s=${W}x${H}:d=1`,
    "-vf", filter,
    "-frames:v", "1",
    input.outputPath,
  ];
}

export type OverlayPlacement = { imagePath: string; x: number; y: number; start: number; end: number; fadeIn: number; fadeOut: number };

/** Where each overlay goes in a clip of the given length; overlays past the clip's end are dropped. */
export function placeOverlays(overlays: SceneOverlay[], frame: Frame, durationSeconds: number, imagePath: (index: number) => string) {
  return overlays.flatMap((overlay, i): OverlayPlacement[] => {
    const end = Math.min(overlay.end, durationSeconds);
    if (overlay.start >= end) return [];
    const layout = overlayLayout(overlay, frame);
    const fades = overlayFades({ ...overlay, end });
    return [{ imagePath: imagePath(i), x: layout.x, y: layout.y, start: round3(overlay.start), end: round3(end), ...fades }];
  });
}

/**
 * Overlays on one timeline made of clips played back to back (a merged Short): each clip's
 * overlays are cut to its length and shifted by the clips before it.
 */
export function sequenceOverlays(clips: { overlays: SceneOverlay[]; durationSeconds: number }[]) {
  let offset = 0;
  return clips.flatMap((clip) => {
    const shifted = clip.overlays.flatMap((o): SceneOverlay[] => {
      const end = Math.min(o.end, clip.durationSeconds);
      return o.start < end ? [{ ...o, start: round3(o.start + offset), end: round3(end + offset) }] : [];
    });
    offset += clip.durationSeconds;
    return shifted;
  });
}

/**
 * Inputs and filter-graph steps that lay overlay images over the stream labelled `from`. The images
 * are added as inputs `firstInput` onwards, each looped so its alpha can fade in and out; the
 * result is labelled `output`.
 */
export function buildOverlayGraph(input: { overlays: OverlayPlacement[]; fps: number; durationSeconds: number; firstInput: number; from: string }) {
  if (!input.overlays.length) throw new Error("No overlays to burn in");
  const args: string[] = [];
  const graph: string[] = [];
  let previous = input.from;
  input.overlays.forEach((o, i) => {
    args.push("-loop", "1", "-framerate", String(input.fps), "-t", String(input.durationSeconds), "-i", o.imagePath);
    const fades = [
      o.fadeIn ? `fade=in:st=${o.start}:d=${o.fadeIn}:alpha=1` : null,
      o.fadeOut ? `fade=out:st=${round3(o.end - o.fadeOut)}:d=${o.fadeOut}:alpha=1` : null,
    ].filter(Boolean);
    graph.push(
      `[${input.firstInput + i}:v]${["format=rgba", ...fades].join(",")}[ov${i}]`,
      `[${previous}][ov${i}]overlay=x=${o.x}:y=${o.y}:enable='between(t,${o.start},${o.end})'[v${i}]`,
    );
    previous = `v${i}`;
  });
  return { args, graph, output: previous };
}

/**
 * FFmpeg arguments that burn overlay images into a copy of a clip. The clip's sound is copied as
 * is, and the output is as long as the clip.
 */
export function buildOverlayBurnArgs(input: {
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
  fps: number;
  overlays: OverlayPlacement[];
}) {
  const overlays = buildOverlayGraph({ ...input, firstInput: 1, from: "0:v" });
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input.inputPath, ...overlays.args];
  args.push(
    "-filter_complex", overlays.graph.join(";"),
    "-map", `[${overlays.output}]`,
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    input.outputPath,
  );
  return args;
}
