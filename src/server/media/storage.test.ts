import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { downloadMedia, MediaError, normalizeContentType, resolveMediaPath, saveMedia } from "./storage";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kids-studio-media-"));
  vi.stubEnv("MEDIA_DIR", root);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("resolveMediaPath", () => {
  it("keeps paths inside the media root", () => {
    expect(resolveMediaPath("scenes/a/b.png", root)).toBe(path.join(root, "scenes", "a", "b.png"));
    expect(resolveMediaPath("../secret.txt", root)).toBeNull();
    expect(resolveMediaPath("scenes/../../x", root)).toBeNull();
    expect(resolveMediaPath(path.resolve(root, "x.png"), root)).toBeNull();
    expect(resolveMediaPath("", root)).toBeNull();
  });
});

describe("saveMedia", () => {
  it("stores supported files under a folder with a random name", async () => {
    const saved = await saveMedia(new Uint8Array([1, 2, 3]), "image/jpg", "scenes/s1");
    expect(saved).toMatchObject({ kind: "image", contentType: "image/jpeg", sizeBytes: 3 });
    expect(saved.filePath).toMatch(/^scenes\/s1\/[0-9a-f-]{36}\.jpg$/);
    expect([...(await readFile(path.join(root, saved.filePath)))]).toEqual([1, 2, 3]);
  });

  it("rejects unsupported and empty files", async () => {
    await expect(saveMedia(new Uint8Array([1]), "application/pdf", "x")).rejects.toBeInstanceOf(MediaError);
    await expect(saveMedia(new Uint8Array(), "image/png", "x")).rejects.toThrow(/empty/);
  });
});

describe("downloadMedia", () => {
  it("only accepts https URLs", async () => {
    await expect(downloadMedia("http://example.com/a.png", "x")).rejects.toThrow(/https/);
    await expect(downloadMedia("not a url", "x")).rejects.toThrow(/valid URL/);
  });

  it("saves the response using its content type", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "video/mp4" } }));
    const saved = await downloadMedia("https://cdn.example.com/clip", "scenes/s2", fetch as typeof globalThis.fetch);
    expect(saved).toMatchObject({ kind: "video", contentType: "video/mp4", sizeBytes: 2 });
  });

  it("reports HTTP failures", async () => {
    const fetch = vi.fn(async () => new Response("gone", { status: 410 }));
    await expect(downloadMedia("https://cdn.example.com/a.png", "x", fetch as typeof globalThis.fetch)).rejects.toThrow(
      /410/,
    );
  });
});

describe("normalizeContentType", () => {
  it("strips parameters and normalises jpg", () => {
    expect(normalizeContentType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(normalizeContentType("image/jpg")).toBe("image/jpeg");
    expect(normalizeContentType(null)).toBe("");
  });
});
