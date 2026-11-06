import "server-only";

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildConcatArgs, type EditSettings, parseProgressSeconds, pickFps, type VideoClip } from "@/lib/long-video";
import { buildOverlayBurnArgs, buildOverlayImageArgs, overlayLayout, placeOverlays, type SceneOverlay } from "@/lib/overlays";
import { type AudioLevels, buildJoinArgs, buildRenderArgs, type Framing, type MediaProbe, OUT_H, OUT_W, parseLoudness, parseProbe } from "@/lib/short-video";

import { resolveMediaPath } from "./storage";

// FFmpeg is a free local tool, run as a child process with an argument array (no shell). Set
// FFMPEG_PATH / FFPROBE_PATH when the binaries aren't on PATH.

export function getFfmpegPaths() {
  return {
    ffmpeg: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH?.trim() || "ffprobe",
  };
}

export class FfmpegError extends Error {}

const RENDER_TIMEOUT_MS = 10 * 60_000;

function run(command: string, args: string[], options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal: options.signal },
      (error, stdout, stderr) => {
        if (error?.name === "AbortError") {
          reject(new FfmpegError("Render cancelled"));
          return;
        }
        if (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          reject(
            new FfmpegError(
              missing
                ? `${path.basename(command)} was not found. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH in .env.local.`
                : `${path.basename(command)} failed: ${lastLines(stderr) || error.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function lastLines(text: string, n = 4) {
  return text.trim().split(/\r?\n/).slice(-n).join(" · ");
}

let cachedVersion: { at: number; version: string | null } | undefined;

/** FFmpeg version string, or null when it isn't installed. Cached for a minute. */
export async function getFfmpegVersion() {
  if (cachedVersion && Date.now() - cachedVersion.at < 60_000) return cachedVersion.version;
  let version: string | null = null;
  try {
    const { ffmpeg, ffprobe } = getFfmpegPaths();
    const [{ stdout }] = await Promise.all([run(ffmpeg, ["-hide_banner", "-version"], { timeout: 10_000 }), run(ffprobe, ["-version"], { timeout: 10_000 })]);
    version = /ffmpeg version (\S+)/.exec(stdout)?.[1] ?? "installed";
  } catch {
    version = null;
  }
  cachedVersion = { at: Date.now(), version };
  return version;
}

function absolute(relative: string) {
  const full = resolveMediaPath(relative);
  if (!full) throw new FfmpegError("Invalid media path");
  return full;
}

export async function probeMedia(relativePath: string): Promise<MediaProbe> {
  const { ffprobe } = getFfmpegPaths();
  const { stdout } = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absolute(relativePath)]);
  return parseProbe(stdout);
}

export async function measureLoudness(relativePath: string): Promise<AudioLevels | null> {
  const { ffmpeg } = getFfmpegPaths();
  const { stderr } = await run(
    ffmpeg,
    ["-hide_banner", "-nostdin", "-nostats", "-i", absolute(relativePath), "-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"],
    { timeout: 5 * 60_000 },
  );
  return parseLoudness(stderr);
}

/**
 * Renders the vertical version into a new file. The source is only read: FFmpeg writes to a new
 * path under `folder`, so the original clip can never be overwritten.
 */
export async function renderVertical(input: {
  sourcePath: string;
  folder: string;
  fileName: string;
  framing: Framing;
  assSubtitles: string | null;
  normalizeAudio: boolean;
  /** Scene text overlays on the source's timeline, laid out in the 1080×1920 frame. */
  overlays: { overlays: SceneOverlay[]; durationSeconds: number; fps: number } | null;
}) {
  const relative = `${input.folder}/${input.fileName}`;
  if (relative === input.sourcePath) throw new FfmpegError("Refusing to overwrite the source clip");
  const outputPath = absolute(relative);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const work = await mkdtemp(path.join(tmpdir(), "kids-studio-short-"));
  try {
    if (input.assSubtitles) await writeFile(path.join(work, "overlay.ass"), input.assSubtitles, "utf8");
    const overlays = input.overlays?.overlays.length
      ? { ...input.overlays, placements: await drawOverlayImages({ ...input.overlays, work, width: OUT_W, height: OUT_H }) }
      : undefined;
    const args = buildRenderArgs({
      inputPath: absolute(input.sourcePath),
      outputPath,
      framing: input.framing,
      subtitlesFile: input.assSubtitles ? "overlay.ass" : null,
      normalizeAudio: input.normalizeAudio,
      overlays,
    });
    await run(getFfmpegPaths().ffmpeg, args, { cwd: work, timeout: RENDER_TIMEOUT_MS });
    const info = await stat(outputPath);
    if (!info.size) throw new FfmpegError("FFmpeg produced an empty file");
    return relative;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Joins scene clips into one new source file for a merged Short. The clips are only read. */
export async function joinClips(input: {
  clips: { filePath: string; durationSeconds: number; hasAudio: boolean; fps: number | null }[];
  width: number;
  height: number;
  folder: string;
  fileName: string;
}) {
  const relative = `${input.folder}/${input.fileName}`;
  if (input.clips.some((c) => c.filePath === relative)) throw new FfmpegError("Refusing to overwrite a source clip");
  const outputPath = absolute(relative);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    const args = buildJoinArgs({
      clips: input.clips.map((c) => ({ ...c, inputPath: absolute(c.filePath) })),
      width: input.width,
      height: input.height,
      fps: pickFps(input.clips),
      outputPath,
    });
    await run(getFfmpegPaths().ffmpeg, args, { timeout: RENDER_TIMEOUT_MS });
    const info = await stat(outputPath);
    if (!info.size) throw new FfmpegError("FFmpeg produced an empty file");
    return relative;
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** A full-length render can take a while: allow an hour before giving up. */
export const LONG_RENDER_TIMEOUT_MS = 60 * 60_000;

/**
 * Joins the clips into one 16:9 file under `folder`. The sources are only read. Reports the share
 * of the timeline encoded so far through `onProgress` (0-1).
 */
export async function renderTimeline(input: {
  clips: VideoClip[];
  settings: EditSettings;
  folder: string;
  fileName: string;
  assSubtitles: string | null;
  onProgress?: (fraction: number) => void;
  /** Aborting stops FFmpeg and deletes the partial file. */
  signal?: AbortSignal;
}) {
  const relative = `${input.folder}/${input.fileName}`;
  if (input.clips.some((c) => c.filePath === relative)) throw new FfmpegError("Refusing to overwrite a source clip");
  const outputPath = absolute(relative);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const work = await mkdtemp(path.join(tmpdir(), "kids-studio-video-"));
  try {
    if (input.assSubtitles) await writeFile(path.join(work, "captions.ass"), input.assSubtitles, "utf8");
    // Overlays go into copies of the clips in the work folder, so their times stay relative to each clip.
    const inputPaths: string[] = [];
    for (const [i, c] of input.clips.entries()) {
      const burned =
        c.overlays?.length && c.width && c.height && c.sourceSeconds
          ? await burnOverlays({
              inputPath: absolute(c.filePath),
              outputPath: path.join(work, `scene-${i + 1}-overlays.mp4`),
              width: c.width,
              height: c.height,
              durationSeconds: c.sourceSeconds,
              fps: Math.round(c.fps ?? 30) || 30,
              overlays: c.overlays,
              signal: input.signal,
            })
          : null;
      inputPaths.push(burned ?? absolute(c.filePath));
    }
    const { args, durationSeconds } = buildConcatArgs({
      clips: input.clips.map((c, i) => ({ ...c, inputPath: inputPaths[i] })),
      settings: input.settings,
      outputPath,
      subtitlesFile: input.assSubtitles ? "captions.ass" : null,
      fps: pickFps(input.clips),
    });
    await runWithProgress(getFfmpegPaths().ffmpeg, args, {
      cwd: work,
      timeout: LONG_RENDER_TIMEOUT_MS,
      signal: input.signal,
      onSeconds: (s) => input.onProgress?.(durationSeconds ? Math.min(1, s / durationSeconds) : 0),
    });
    const info = await stat(outputPath);
    if (!info.size) throw new FfmpegError("FFmpeg produced an empty file");
    return relative;
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Child-friendly rounded font for burned-in overlays (SIL Open Font License, see assets/fonts/OFL.txt).
const OVERLAY_FONT = path.join(/*turbopackIgnore: true*/ process.cwd(), "assets", "fonts", "VarelaRound-Regular.ttf");

/**
 * Draws each overlay that falls inside the clip into a transparent PNG in `work`, sized to its text
 * for a frame of `width`×`height`, and returns where each goes. FFmpeg later runs in `work`, so the
 * images are referred to by bare name.
 */
async function drawOverlayImages(input: {
  work: string;
  width: number;
  height: number;
  durationSeconds: number;
  overlays: SceneOverlay[];
  signal?: AbortSignal;
}) {
  const frame = { width: input.width, height: input.height };
  const placements = placeOverlays(input.overlays, frame, input.durationSeconds, (i) => `overlay-${i}.png`);
  if (!placements.length) return placements;
  await copyFile(OVERLAY_FONT, path.join(input.work, "font.ttf"));
  for (const [i, overlay] of input.overlays.entries()) {
    if (!placements.some((p) => p.imagePath === `overlay-${i}.png`)) continue;
    const layout = overlayLayout(overlay, frame);
    const lineFiles = layout.lines.map((_, j) => `overlay-${i}-line-${j}.txt`);
    await Promise.all(layout.lines.map((line, j) => writeFile(path.join(input.work, lineFiles[j]), line, "utf8")));
    const args = buildOverlayImageArgs({ type: overlay.type, layout, fontFile: "font.ttf", lineFiles, outputPath: `overlay-${i}.png` });
    await run(getFfmpegPaths().ffmpeg, args, { cwd: input.work, signal: input.signal });
  }
  return placements;
}

/**
 * Burns a scene's text overlays into a new copy of its clip at `outputPath` (absolute) and returns
 * that path, or null when no overlay falls inside the clip. The clip is only read. Each overlay is
 * first drawn into a transparent PNG sized to its text, then laid over the clip with its fades.
 */
export async function burnOverlays(input: {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
  overlays: SceneOverlay[];
  signal?: AbortSignal;
}) {
  if (path.resolve(input.outputPath) === path.resolve(input.inputPath)) throw new FfmpegError("Refusing to overwrite the source clip");
  const work = await mkdtemp(path.join(tmpdir(), "kids-studio-overlays-"));
  try {
    const placements = await drawOverlayImages({ ...input, work });
    if (!placements.length) return null;
    const args = buildOverlayBurnArgs({
      inputPath: input.inputPath,
      outputPath: input.outputPath,
      durationSeconds: input.durationSeconds,
      fps: input.fps,
      overlays: placements,
    });
    await run(getFfmpegPaths().ffmpeg, args, { cwd: work, timeout: RENDER_TIMEOUT_MS, signal: input.signal });
    return input.outputPath;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Like `run`, but streams FFmpeg's `-progress pipe:1` output instead of buffering it. */
function runWithProgress(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal; onSeconds: (s: number) => void },
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const seconds = parseProgressSeconds(chunk);
      if (seconds !== null) options.onSeconds(seconds);
    });
    // Only the tail is kept for the error message.
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.name === "AbortError") return reject(new FfmpegError("Render cancelled"));
      reject(
        new FfmpegError(
          error.code === "ENOENT"
            ? `${path.basename(command)} was not found. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH in .env.local.`
            : `${path.basename(command)} failed: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new FfmpegError(`${path.basename(command)} failed: ${lastLines(stderr) || (signal ? `stopped (${signal})` : `exit code ${code}`)}`));
    });
  });
}

// ---------- Frames for the vision check ----------

/** Runs FFmpeg and returns its binary stdout (an encoded image). */
function runBinary(command: string, args: string[], timeout = 60_000) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new FfmpegError(
            missing
              ? `${path.basename(command)} was not found. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH in .env.local.`
              : `${path.basename(command)} failed: ${lastLines(stderr.toString("utf8")) || error.message}`,
          ),
        );
        return;
      }
      if (!stdout.length) reject(new FfmpegError("FFmpeg produced no image"));
      else resolve(stdout);
    });
  });
}

/**
 * One small JPEG per timestamp, read from the clip without changing it. Small frames keep vision
 * calls cheap: a 512-pixel-wide frame costs a few hundred input tokens.
 */
export async function extractFrames(relativePath: string, times: number[], width = 512) {
  const { ffmpeg } = getFfmpegPaths();
  const input = absolute(relativePath);
  const frames: { time: number; jpeg: Buffer }[] = [];
  for (const time of times) {
    // -ss before -i seeks fast to the nearest keyframe, then decodes forward to the exact time.
    const jpeg = await runBinary(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-ss", time.toFixed(2), "-i", input,
      "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5",
      "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ]);
    frames.push({ time, jpeg });
  }
  return frames;
}

/**
 * The clip's final frame as a full-size PNG, to start the next scene from. Decodes the last half
 * second and keeps overwriting one file, so whatever frame comes last wins.
 */
export async function extractLastFrame(relativePath: string) {
  const { ffmpeg } = getFfmpegPaths();
  const dir = await mkdtemp(path.join(tmpdir(), "last-frame-"));
  const output = path.join(dir, "frame.png");
  try {
    await run(ffmpeg, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-sseof", "-0.5", "-i", absolute(relativePath),
      "-an", "-update", "1", "-y", output,
    ]);
    const png = await readFile(output).catch(() => null);
    if (!png?.length) throw new FfmpegError("FFmpeg produced no image");
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A still image (e.g. a reference) shrunk to a small JPEG. */
export async function downscaleImage(relativePath: string, width = 512) {
  const { ffmpeg } = getFfmpegPaths();
  return runBinary(ffmpeg, [
    "-hide_banner", "-nostdin", "-loglevel", "error",
    "-i", absolute(relativePath),
    "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "5",
    "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
  ]);
}
