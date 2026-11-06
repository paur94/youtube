import { describe, expect, it } from "vitest";

import { buildRequestBody, generatesAudio, getHiggsfieldModel } from "./higgsfield";
import { estimateReplicateCost, replicateToRemoteStatus } from "./replicate";

function model(id: string) {
  const m = getHiggsfieldModel(id);
  if (!m) throw new Error(`missing model ${id}`);
  return m;
}

describe("Replicate Wan 3.0 models", () => {
  it("sends the start frame as image, without aspect_ratio, and keeps the negative prompt", () => {
    const body = buildRequestBody(model("replicate-wan-3-i2v"), {
      prompt: "A fox runs",
      negativePrompt: "blurry",
      aspectRatio: "9:16",
      durationSeconds: 7.2,
      imageUrl: "https://api.replicate.com/v1/files/abc",
    });
    expect(body).toEqual({
      prompt: "A fox runs",
      resolution: "720p",
      enable_prompt_expansion: false,
      image: "https://api.replicate.com/v1/files/abc",
      duration: 8,
      negative_prompt: "blurry",
    });
  });

  it("text to video uses the plan aspect ratio and clamps the duration to 2-30s", () => {
    const body = buildRequestBody(model("replicate-wan-3-t2v"), { prompt: "p", aspectRatio: "16:9", durationSeconds: 45 });
    expect(body).toMatchObject({ aspect_ratio: "16:9", duration: 30 });
    expect(body).not.toHaveProperty("image");
  });

  it("always generates sound, so the prompt carries the dialogue", () => {
    expect(generatesAudio(model("replicate-wan-3-i2v"))).toBe(true);
    expect(generatesAudio(model("replicate-wan-3-t2v"))).toBe(true);
  });

  it("estimates $0.10 per second at 720p", () => {
    expect(estimateReplicateCost(model("replicate-wan-3-t2v"), { duration: 10 })).toBe(1);
    expect(estimateReplicateCost(model("wan-3.0-t2v"), { duration: 10 })).toBeNull();
  });
});

describe("Replicate Kling 4.0 models", () => {
  it("sends the start frame as start_image, without aspect_ratio or negative prompt", () => {
    const body = buildRequestBody(model("replicate-kling-4-i2v"), {
      prompt: "A fox runs",
      negativePrompt: "blurry",
      aspectRatio: "9:16",
      durationSeconds: 2,
      imageUrl: "https://api.replicate.com/v1/files/abc",
    });
    expect(body).toEqual({
      prompt: "A fox runs",
      resolution: "720p",
      start_image: "https://api.replicate.com/v1/files/abc",
      duration: 3,
    });
  });

  it("sends character references as reference_images", () => {
    const refs = ["https://x/a.png", "https://x/b.png"];
    const body = buildRequestBody(model("replicate-kling-4-r2v"), {
      prompt: "p",
      aspectRatio: "9:16",
      durationSeconds: 45,
      referenceUrls: refs,
    });
    expect(body).toEqual({ prompt: "p", resolution: "720p", aspect_ratio: "9:16", reference_images: refs, duration: 30 });
  });

  it("always generates sound and estimates $0.157 per second at 720p", () => {
    expect(generatesAudio(model("replicate-kling-4-t2v"))).toBe(true);
    expect(estimateReplicateCost(model("replicate-kling-4-t2v"), { duration: 10 })).toBe(1.57);
  });
});

describe("replicateToRemoteStatus", () => {
  it("maps queue states", () => {
    expect(replicateToRemoteStatus({ id: "p", status: "starting" })).toEqual({ status: "queued" });
    expect(replicateToRemoteStatus({ id: "p", status: "processing" })).toEqual({ status: "in_progress" });
  });

  it("returns the output URL as the video and when Replicate deletes it", () => {
    expect(
      replicateToRemoteStatus({
        id: "p",
        status: "succeeded",
        output: "https://replicate.delivery/out.mp4",
        completed_at: "2026-11-04T10:00:00.000Z",
      }),
    ).toEqual({
      status: "completed",
      video: { url: "https://replicate.delivery/out.mp4" },
      expires_at: "2026-11-04T11:00:00.000Z",
    });
    expect(replicateToRemoteStatus({ id: "p", status: "succeeded", output: ["https://x/a.mp4"] }).video).toEqual({
      url: "https://x/a.mp4",
    });
  });

  it("treats moderation errors as nsfw and other failures as failed", () => {
    expect(replicateToRemoteStatus({ id: "p", status: "failed", error: "E005: input flagged as sensitive" })).toEqual({
      status: "nsfw",
    });
    expect(replicateToRemoteStatus({ id: "p", status: "failed", error: "CUDA out of memory" })).toEqual({
      status: "failed",
      error: "CUDA out of memory",
    });
    expect(replicateToRemoteStatus({ id: "p", status: "aborted" })).toEqual({ status: "canceled" });
  });
});
