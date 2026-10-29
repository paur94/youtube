import { JOB_TIMEOUT_MS, type AssetKind, type JobStatus } from "./production";

// Shape of a Higgsfield status response, as far as job tracking needs it.
export type RemoteStatus = {
  status: "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";
  error?: string | null;
  images?: { url: string }[] | null;
  video?: { url: string } | null;
  expires_at?: string | null;
};

export type JobUpdate = {
  status: JobStatus;
  error: string | null;
  outputs: { url: string; kind: AssetKind }[];
  outputExpiresAt: Date | null;
  terminal: boolean;
};

/** Decides a job's new state from a status response; never reports success without outputs. */
export function interpretRemoteStatus(
  remote: RemoteStatus,
  job: { submittedAt: Date | null; outputKind: AssetKind },
  now = new Date(),
  timeoutMs = JOB_TIMEOUT_MS,
): JobUpdate {
  const expires = remote.expires_at ? new Date(remote.expires_at) : null;
  const outputExpiresAt = expires && !Number.isNaN(expires.getTime()) ? expires : null;
  const base = { error: null, outputs: [], outputExpiresAt, terminal: true };

  switch (remote.status) {
    case "completed": {
      const outputs = [
        ...(remote.images ?? []).map((o) => ({ url: o.url, kind: "image" as const })),
        ...(remote.video ? [{ url: remote.video.url, kind: "video" as const }] : []),
      ];
      if (outputs.length === 0) {
        return { ...base, status: "failed", error: "Higgsfield reported completion but returned no files." };
      }
      return { ...base, status: "completed", outputs };
    }
    case "failed":
      return { ...base, status: "failed", error: remote.error || "Higgsfield reported that the generation failed." };
    case "nsfw":
      return {
        ...base,
        status: "nsfw",
        error: "Higgsfield's content moderation rejected the input or output. Revise the prompt. You are not charged.",
      };
    case "canceled":
      return { ...base, status: "canceled", error: "The request was canceled before it started." };
    case "queued":
    case "in_progress": {
      if (job.submittedAt && now.getTime() - job.submittedAt.getTime() > timeoutMs) {
        return {
          ...base,
          status: "timed_out",
          error: `Still ${remote.status === "queued" ? "queued" : "running"} after ${Math.round(timeoutMs / 60_000)} minutes. Check again later or retry.`,
        };
      }
      return { ...base, status: remote.status, terminal: false };
    }
  }
}
