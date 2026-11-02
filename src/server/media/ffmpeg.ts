import "server-only";

import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildConcatArgs, type EditSettings, parseProgressSeconds, pickFps, type VideoClip } from "@/lib/long-video";
import { type AudioLevels, buildRenderArgs, type Framing, type MediaProbe, parseLoudness, parseProbe } from "@/lib/short-video";

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

function run(command: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
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
}) {
  const relative = `${input.folder}/${input.fileName}`;
  if (relative === input.sourcePath) throw new FfmpegError("Refusing to overwrite the source clip");
  const outputPath = absolute(relative);
  await mkdir(path.dirname(outputPath), { recursive: true });

  const work = await mkdtemp(path.join(tmpdir(), "kids-studio-short-"));
  try {
    if (input.assSubtitles) await writeFile(path.join(work, "overlay.ass"), input.assSubtitles, "utf8");
    const args = buildRenderArgs({
      inputPath: absolute(input.sourcePath),
      outputPath,
      framing: input.framing,
      subtitlesFile: input.assSubtitles ? "overlay.ass" : null,
      normalizeAudio: input.normalizeAudio,
    });
    await run(getFfmpegPaths().ffmpeg, args, { cwd: work, timeout: RENDER_TIMEOUT_MS });
    const info = await stat(outputPath);
    if (!info.size) throw new FfmpegError("FFmpeg produced an empty file");
    return relative;
  } finally {
    await rm(work, { recursive: true, force: true });
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
    const { args, durationSeconds } = buildConcatArgs({
      clips: input.clips.map((c) => ({ ...c, inputPath: absolute(c.filePath) })),
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
