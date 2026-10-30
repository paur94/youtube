import { describe, expect, it } from "vitest";

import { interpretRemoteStatus } from "./generation-jobs";
import { checkHedraAudio, hedraToRemoteStatus, isHedraJobRequest } from "./hedra";

describe("hedraToRemoteStatus", () => {
  it("maps queue states", () => {
    expect(hedraToRemoteStatus({ status: "IN_QUEUE" })).toEqual({ status: "queued" });
    expect(hedraToRemoteStatus({ status: "IN_PROGRESS" })).toEqual({ status: "in_progress" });
  });

  it("uses the first completed output as the video", () => {
    const remote = hedraToRemoteStatus({
      status: "COMPLETED",
      outputs: [
        { status: "FAILED", url: null },
        { status: "COMPLETED", url: "https://cdn.hedra.com/out.mp4" },
      ],
    });
    expect(remote).toEqual({ status: "completed", video: { url: "https://cdn.hedra.com/out.mp4" } });
  });

  it("never reports success without a file", () => {
    const update = interpretRemoteStatus(
      hedraToRemoteStatus({ status: "COMPLETED", outputs: [] }),
      { submittedAt: new Date(), outputKind: "video" },
      new Date(),
      60_000,
      "Hedra",
    );
    expect(update).toMatchObject({ status: "failed", error: "Hedra reported completion but returned no files." });
  });

  it("maps failures and moderation", () => {
    expect(hedraToRemoteStatus({ status: "FAILED", error: { code: "INTERNAL", message: "boom" } })).toEqual({
      status: "failed",
      error: "boom",
    });
    expect(hedraToRemoteStatus({ status: "FAILED", error: { code: "MODERATION_FAILED" } }).status).toBe("nsfw");
    expect(hedraToRemoteStatus({ status: "FAILED", error: null })).toEqual({ status: "failed", error: null });
  });
});

describe("checkHedraAudio", () => {
  it("accepts MP3, WAV and M4A up to 100 MB", () => {
    expect(checkHedraAudio("audio/mpeg", 1000)).toBeNull();
    expect(checkHedraAudio("audio/wav", 1000)).toBeNull();
    expect(checkHedraAudio("audio/ogg", 1000)).toMatch(/MP3/);
    expect(checkHedraAudio("audio/mpeg", 0)).toMatch(/empty/);
    expect(checkHedraAudio("audio/mpeg", 200 * 1024 * 1024)).toMatch(/100 MB/);
  });
});

describe("isHedraJobRequest", () => {
  it("recognises stored Hedra requests only", () => {
    const request = {
      input: { prompt: "p", aspect_ratio: "16:9", resolution: "540p" },
      startImage: { filePath: "scenes/a/x.png", contentType: "image/png" },
      audio: { filePath: "scenes/a/inputs/y.mp3", contentType: "audio/mpeg" },
    };
    expect(isHedraJobRequest(request)).toBe(true);
    expect(isHedraJobRequest({ prompt: "duck" })).toBe(false);
    expect(isHedraJobRequest(null)).toBe(false);
  });
});
