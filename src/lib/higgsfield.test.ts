import { describe, expect, it } from "vitest";

import { buildRequestBody, getHiggsfieldModel, HIGGSFIELD_MODELS, outputDuration, pickDuration } from "./higgsfield";

const params = { prompt: "A duckling", negativePrompt: "text", aspectRatio: "16:9" as const, durationSeconds: 7 };

function model(id: string) {
  const m = getHiggsfieldModel(id);
  if (!m) throw new Error(`missing ${id}`);
  return m;
}

describe("Higgsfield model registry", () => {
  it("has unique ids and documented paths", () => {
    expect(new Set(HIGGSFIELD_MODELS.map((m) => m.id)).size).toBe(HIGGSFIELD_MODELS.length);
    for (const m of HIGGSFIELD_MODELS) expect(m.path).toMatch(/^\/[a-z0-9.-]+(\/[a-z0-9.-]+)+$/);
  });
});

describe("buildRequestBody", () => {
  it("sends Soul only the documented image fields", () => {
    expect(buildRequestBody(model("soul-standard"), { ...params, numImages: 9 })).toEqual({
      prompt: "A duckling",
      aspect_ratio: "16:9",
      num_images: 4,
    });
  });

  it("sends Grok Image 2.0 character references as ordered image_urls", () => {
    const refs = Array.from({ length: 12 }, (_, i) => `https://x/${i}.png`);
    expect(buildRequestBody(model("grok-image-2"), { ...params, referenceUrls: refs })).toEqual({
      prompt: "A duckling",
      quality: "medium",
      resolution: "2k",
      aspect_ratio: "16:9",
      image_urls: refs.slice(0, 10),
    });
    expect(buildRequestBody(model("grok-image-2"), params)).not.toHaveProperty("image_urls");
    expect(buildRequestBody(model("soul-standard"), { ...params, referenceUrls: refs })).not.toHaveProperty("image_urls");
  });

  it("builds a PixVerse V6 request at 720p with sound, capped at 15s", () => {
    const body = buildRequestBody(model("pixverse-v6-i2v"), { ...params, durationSeconds: 20, imageUrl: "https://x/img.png" });
    expect(body).toEqual({
      prompt: "A duckling",
      image_url: "https://x/img.png",
      resolution: "720p",
      generate_audio: true,
      duration: 15,
      negative_prompt: "text",
    });
  });

  it("sends Soul V2 the prompt only", () => {
    expect(buildRequestBody(model("soul-v2-standard"), params)).toEqual({ prompt: "A duckling" });
  });

  it("builds a Kling image-to-video request with negative prompt and duration", () => {
    const body = buildRequestBody(model("kling-2.5-turbo-pro-i2v"), { ...params, imageUrl: "https://x/img.png" });
    expect(body).toEqual({ prompt: "A duckling", image_url: "https://x/img.png", duration: 10, negative_prompt: "text" });
    expect(outputDuration(model("kling-2.5-turbo-pro-i2v"), body)).toBe(10);
  });

  it("omits the negative prompt for models that don't support it", () => {
    const body = buildRequestBody(model("hailuo-2.3-standard-t2v"), { ...params, durationSeconds: 4 });
    expect(body).toEqual({ prompt: "A duckling", duration: 6 });
  });

  it("builds Seedance 2.5 requests with any duration in range and no audio", () => {
    const i2v = buildRequestBody(model("seedance-2.5-i2v"), { ...params, durationSeconds: 20, imageUrl: "https://x/a.png" });
    expect(i2v).toEqual({
      prompt: "A duckling",
      image_url: "https://x/a.png",
      duration: 20,
      resolution: "1080p",
      generate_audio: false,
    });
    const t2v = buildRequestBody(model("seedance-2.5-t2v"), { ...params, durationSeconds: 2.2 });
    expect(t2v).toMatchObject({ duration: 4, aspect_ratio: "16:9" });
    expect(t2v).not.toHaveProperty("negative_prompt");
    expect(buildRequestBody(model("seedance-2.5-t2v"), { ...params, durationSeconds: 45 }).duration).toBe(30);
  });

  it("requires a start image for image-to-video", () => {
    expect(() => buildRequestBody(model("hailuo-2.3-standard-i2v"), params)).toThrow(/start image/);
  });
});

describe("pickDuration", () => {
  it("covers the scene when possible, otherwise uses the longest", () => {
    expect(pickDuration([5, 10], 3)).toBe(5);
    expect(pickDuration([5, 10], 6)).toBe(10);
    expect(pickDuration([10, 5], 30)).toBe(10);
  });
});
