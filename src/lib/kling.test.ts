import { describe, expect, it } from "vitest";

import { buildRequestBody, getHiggsfieldModel } from "./higgsfield";
import {
  checkKlingImage,
  checkKlingImageCounts,
  describeKlingFrames,
  KLING_MAX_IMAGES,
  KLING_MAX_MIDDLE_IMAGES,
  readImageSize,
  readSceneFrames,
  supportsKeyframes,
} from "./kling";

/** Minimal PNG header: signature, IHDR length and type, then width and height. */
function png(width: number, height: number) {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** JPEG with an APP0 segment before the SOF0 frame header, as cameras and editors write them. */
function jpeg(width: number, height: number, progressive = false) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, progressive ? 0xc2 : 0xc0, 0x00, 0x11, 8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

describe("readImageSize", () => {
  it("reads PNG and JPEG headers without decoding", () => {
    expect(readImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(readImageSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readImageSize(jpeg(640, 480, true))).toEqual({ width: 640, height: 480 });
  });

  it("returns null for other formats and truncated files", () => {
    expect(readImageSize(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull();
    expect(readImageSize(png(800, 600).slice(0, 20))).toBeNull();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readImageSize(new Uint8Array())).toBeNull();
  });
});

describe("checkKlingImage", () => {
  const ok = { contentType: "image/png", sizeBytes: 1_000_000, size: { width: 1920, height: 1080 } };

  it("accepts JPEG and PNG within the documented limits", () => {
    expect(checkKlingImage(ok, "start image")).toBeNull();
    expect(checkKlingImage({ ...ok, contentType: "image/jpeg", size: { width: 300, height: 750 } }, "end image")).toBeNull();
    expect(checkKlingImage({ contentType: "image/png", sizeBytes: null }, "middle image 1")).toBeNull();
  });

  it("rejects formats the app stores but Kling doesn't take", () => {
    expect(checkKlingImage({ ...ok, contentType: "image/webp" }, "start image")).toMatch(/JPEG or PNG.*WEBP/);
    expect(checkKlingImage({ ...ok, contentType: "image/gif" }, "end image")).toMatch(/end image must be a JPEG or PNG/);
    expect(checkKlingImage({ ...ok, contentType: null }, "start image")).toMatch(/unknown type/);
  });

  it("rejects files over 30 MB, under 300 px or outside 2:5 to 5:2", () => {
    expect(checkKlingImage({ ...ok, sizeBytes: 30 * 1024 * 1024 + 1 }, "start image")).toMatch(/larger than 30 MB/);
    expect(checkKlingImage({ ...ok, size: { width: 299, height: 1000 } }, "middle image 2")).toMatch(/middle image 2 is 299×1000 px.*300 px/);
    expect(checkKlingImage({ ...ok, size: { width: 1000, height: 399 } }, "end image")).toMatch(/aspect ratio between 2:5 and 5:2/);
    expect(checkKlingImage({ ...ok, size: { width: 400, height: 1001 } }, "end image")).toMatch(/aspect ratio/);
  });
});

describe("checkKlingImageCounts", () => {
  it("allows up to 10 images in total and 8 middle images", () => {
    expect(checkKlingImageCounts({ start: true, middle: 0, end: false })).toBeNull();
    expect(checkKlingImageCounts({ start: true, middle: KLING_MAX_MIDDLE_IMAGES, end: true })).toBeNull();
    expect(checkKlingImageCounts({ start: true, middle: KLING_MAX_MIDDLE_IMAGES + 1, end: false })).toMatch(/at most 8 middle/);
    expect(checkKlingImageCounts({ start: true, middle: 8, end: true, references: 1 })).toMatch(/at most 10 images in total; this request has 11/);
    expect(KLING_MAX_IMAGES).toBe(10);
  });
});

describe("describeKlingFrames", () => {
  it("numbers the keyframes the way Kling does: start, middle images, end", () => {
    expect(describeKlingFrames({ middle: 0, end: false })).toBe("");
    expect(describeKlingFrames({ middle: 0, end: true })).toMatch(/^@image_1 is the first frame\. @image_2 is the last frame\./);
    expect(describeKlingFrames({ middle: 1, end: false })).toContain("@image_2 is a keyframe the clip passes through midway");
    const text = describeKlingFrames({ middle: 3, end: true });
    expect(text).toContain("@image_2, @image_3 and @image_4 are keyframes the clip passes through in that order");
    expect(text).toContain("@image_5 is the last frame.");
  });
});

describe("readSceneFrames", () => {
  it("tolerates missing or malformed continuity", () => {
    expect(readSceneFrames(null)).toEqual({ middleAssetIds: [], endAssetId: null });
    expect(readSceneFrames({ frames: null })).toEqual({ middleAssetIds: [], endAssetId: null });
    expect(readSceneFrames({ frames: { middleAssetIds: ["a", 3 as unknown as string], endAssetId: "b" } })).toEqual({
      middleAssetIds: ["a"],
      endAssetId: "b",
    });
  });
});

// Input properties of kwaivgi/kling-v4.0 on Replicate (GET /v1/models/kwaivgi/kling-v4.0, November 2026), so a
// request can be checked against the documented fields without creating a prediction.
const KLING_INPUT_SCHEMA: Record<string, "string" | "integer" | "array"> = {
  prompt: "string",
  start_image: "string",
  middle_images: "array",
  end_image: "string",
  reference_images: "array",
  reference_videos: "array",
  base_video: "string",
  resolution: "string",
  aspect_ratio: "string",
  duration: "integer",
};

function expectDocumented(body: Record<string, unknown>) {
  for (const [key, value] of Object.entries(body)) {
    const type = KLING_INPUT_SCHEMA[key];
    expect(type, `undocumented field ${key}`).toBeDefined();
    if (type === "array") expect(Array.isArray(value), key).toBe(true);
    else if (type === "integer") expect(Number.isInteger(value), key).toBe(true);
    else expect(typeof value, key).toBe("string");
  }
}

describe("Kling 4.0 keyframe requests", () => {
  const kling = getHiggsfieldModel("replicate-kling-4-i2v")!;

  it("sends only fields in Kling's documented input schema, for every Kling entry", () => {
    const refs = ["https://x/r1.png"];
    expectDocumented(
      buildRequestBody(kling, {
        prompt: "p",
        aspectRatio: "16:9",
        durationSeconds: 8,
        imageUrl: "https://x/s.png",
        middleImageUrls: ["https://x/m.png"],
        endImageUrl: "https://x/e.png",
      }),
    );
    expectDocumented(buildRequestBody(getHiggsfieldModel("replicate-kling-4-r2v")!, { prompt: "p", aspectRatio: "9:16", durationSeconds: 8, referenceUrls: refs }));
    expectDocumented(buildRequestBody(getHiggsfieldModel("replicate-kling-4-t2v")!, { prompt: "p", aspectRatio: "1:1", durationSeconds: 8 }));
  });

  it("only the Kling start-frame model takes keyframes", () => {
    expect(supportsKeyframes(kling)).toBe(true);
    for (const id of ["replicate-wan-3-i2v", "wan-3.0-i2v", "replicate-kling-4-t2v", "replicate-kling-4-r2v"]) {
      expect(supportsKeyframes(getHiggsfieldModel(id))).toBe(false);
    }
  });

  it("sends start_image, middle_images in order and end_image, without aspect_ratio", () => {
    const body = buildRequestBody(kling, {
      prompt: "p",
      aspectRatio: "9:16",
      durationSeconds: 10,
      imageUrl: "https://x/start.png",
      middleImageUrls: ["https://x/m1.png", "https://x/m2.png"],
      endImageUrl: "https://x/end.png",
    });
    expect(body).toEqual({
      prompt: "p",
      resolution: "720p",
      start_image: "https://x/start.png",
      middle_images: ["https://x/m1.png", "https://x/m2.png"],
      end_image: "https://x/end.png",
      duration: 10,
    });
  });

  it("omits empty keyframe fields and never sends them for Wan 3.0", () => {
    const onlyStart = buildRequestBody(kling, { prompt: "p", aspectRatio: "16:9", durationSeconds: 5, imageUrl: "https://x/s.png", middleImageUrls: [] });
    expect(onlyStart).not.toHaveProperty("middle_images");
    expect(onlyStart).not.toHaveProperty("end_image");
    for (const id of ["replicate-wan-3-i2v", "wan-3.0-i2v"]) {
      const wan = buildRequestBody(getHiggsfieldModel(id)!, {
        prompt: "p",
        aspectRatio: "16:9",
        durationSeconds: 5,
        imageUrl: "https://x/s.png",
        middleImageUrls: ["https://x/m.png"],
        endImageUrl: "https://x/e.png",
      });
      expect(wan).not.toHaveProperty("middle_images");
      expect(wan).not.toHaveProperty("end_image");
    }
  });
});
