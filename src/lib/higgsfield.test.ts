import { describe, expect, it } from "vitest";

import { buildRequestBody, generatesAudio, getHiggsfieldModel, HIGGSFIELD_MODELS, outputDuration } from "./higgsfield";

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

  it("sends Soul V2 the prompt only", () => {
    expect(buildRequestBody(model("soul-v2-standard"), params)).toEqual({ prompt: "A duckling" });
  });

  it("builds Wan 3.0 requests at 720p with sound and the documented fields only", () => {
    const i2v = buildRequestBody(model("wan-3.0-i2v"), { ...params, durationSeconds: 40, imageUrl: "https://x/a.png" });
    expect(i2v).toEqual({
      prompt: "A duckling",
      image_url: "https://x/a.png",
      resolution: "720p",
      generate_audio: true,
      aspect_ratio: "16:9",
      duration: 30,
    });
    const refs = Array.from({ length: 12 }, (_, i) => `https://x/${i}.png`);
    const r2v = buildRequestBody(model("wan-3.0-r2v"), { ...params, aspectRatio: "9:16", referenceUrls: refs });
    expect(r2v).toMatchObject({ aspect_ratio: "9:16", duration: 7, image_urls: refs.slice(0, 10) });
    expect(r2v).not.toHaveProperty("image_url");
    expect(r2v).not.toHaveProperty("negative_prompt");
    expect(buildRequestBody(model("wan-3.0-t2v"), { ...params, durationSeconds: 1 }).duration).toBe(2);
  });

  it("requires a start image for image-to-video", () => {
    expect(() => buildRequestBody(model("wan-3.0-i2v"), params)).toThrow(/start image/);
  });
});
