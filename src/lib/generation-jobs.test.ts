import { describe, expect, it } from "vitest";

import { interpretRemoteStatus } from "./generation-jobs";

const now = new Date("2026-10-26T12:00:00Z");
const job = { submittedAt: new Date("2026-10-26T11:55:00Z"), outputKind: "image" as const };

describe("interpretRemoteStatus", () => {
  it("collects image and video outputs on completion", () => {
    const update = interpretRemoteStatus(
      {
        status: "completed",
        images: [{ url: "https://cdn/a.jpg" }, { url: "https://cdn/b.jpg" }],
        expires_at: "2026-11-02T12:00:00Z",
      },
      job,
      now,
    );
    expect(update).toMatchObject({ status: "completed", terminal: true, error: null });
    expect(update.outputs).toEqual([
      { url: "https://cdn/a.jpg", kind: "image" },
      { url: "https://cdn/b.jpg", kind: "image" },
    ]);
    expect(update.outputExpiresAt?.toISOString()).toBe("2026-11-02T12:00:00.000Z");

    const video = interpretRemoteStatus({ status: "completed", video: { url: "https://cdn/v.mp4" } }, job, now);
    expect(video.outputs).toEqual([{ url: "https://cdn/v.mp4", kind: "video" }]);
  });

  it("never treats a completion without files as success", () => {
    expect(interpretRemoteStatus({ status: "completed", images: [] }, job, now)).toMatchObject({
      status: "failed",
      terminal: true,
    });
  });

  it("passes on provider errors and moderation", () => {
    expect(interpretRemoteStatus({ status: "failed", error: "GPU exploded" }, job, now)).toMatchObject({
      status: "failed",
      error: "GPU exploded",
    });
    expect(interpretRemoteStatus({ status: "nsfw" }, job, now).status).toBe("nsfw");
    expect(interpretRemoteStatus({ status: "canceled" }, job, now).status).toBe("canceled");
  });

  it("keeps active jobs running until the timeout", () => {
    expect(interpretRemoteStatus({ status: "in_progress" }, job, now)).toMatchObject({
      status: "in_progress",
      terminal: false,
    });
    const late = new Date("2026-10-26T12:40:00Z");
    expect(interpretRemoteStatus({ status: "queued" }, job, late)).toMatchObject({ status: "timed_out", terminal: true });
    // A manual "check again" disables the timeout.
    expect(interpretRemoteStatus({ status: "queued" }, job, late, Infinity).status).toBe("queued");
  });
});
