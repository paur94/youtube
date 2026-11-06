import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { burnOverlays, getFfmpegPaths, getFfmpegVersion } from "./ffmpeg";

const exec = promisify(execFile);
const ffmpegInstalled = Boolean(await getFfmpegVersion());

async function durationOf(file: string) {
  const { stdout } = await exec(getFfmpegPaths().ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
}

// Runs the real FFmpeg on a short synthetic clip; skipped where FFmpeg isn't installed.
describe.skipIf(!ffmpegInstalled)("burnOverlays", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "overlay-test-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const [label, width, height] of [["horizontal", 640, 360], ["vertical", 360, 640]] as const) {
    it(`burns a bubble into a ${label} clip without changing its length or the source`, async () => {
      const source = path.join(dir, `${label}.mp4`);
      await exec(getFfmpegPaths().ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=24:d=3`,
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
      ]);
      const before = await stat(source);
      const output = path.join(dir, `${label}-overlays.mp4`);

      const result = await burnOverlays({
        inputPath: source,
        outputPath: output,
        width,
        height,
        durationSeconds: 3,
        fps: 24,
        overlays: [{ id: "o1", type: "bubble", text: "Working late. Love you.", position: "top-right", start: 0.5, end: 2.5 }],
      });

      expect(result).toBe(output);
      expect((await stat(output)).size).toBeGreaterThan(0);
      expect(await durationOf(output)).toBeCloseTo(await durationOf(source), 1);
      expect((await stat(source)).mtimeMs).toBe(before.mtimeMs);
    }, 60_000);
  }

  it("does nothing when every overlay is past the end of the clip", async () => {
    const result = await burnOverlays({
      inputPath: path.join(dir, "horizontal.mp4"),
      outputPath: path.join(dir, "unused.mp4"),
      width: 640,
      height: 360,
      durationSeconds: 3,
      fps: 24,
      overlays: [{ id: "o1", type: "caption", text: "Later", position: "bottom-center", start: 5, end: 6 }],
    });
    expect(result).toBeNull();
  });
});
