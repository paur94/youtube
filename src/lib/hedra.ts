import type { RemoteStatus } from "./generation-jobs";
import type { AspectRatio } from "./production";

// Hedra API v3, Character 3 only (https://www.hedra.com/docs/api-reference/v3/run-a-model/
// run-hedra-character-3-hedra-character-3.md, checked October 2026). It animates a start image so the
// character speaks or sings the driving audio, which Higgsfield can't do.
export const HEDRA_MODEL = {
  id: "hedra-character-3",
  label: "Hedra Character 3 (talking character from image + audio)",
} as const;

export const HEDRA_PROVIDER = "hedra";

export const HEDRA_RESOLUTIONS = ["540p", "720p", "1080p"] as const;
export type HedraResolution = (typeof HEDRA_RESOLUTIONS)[number];
export const DEFAULT_HEDRA_RESOLUTION: HedraResolution = "540p";

// Every app aspect ratio is in Hedra's list (1:1, 4:3, 3:4, 16:9, 9:16, 9:21, 21:9).
export const HEDRA_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_HEDRA_IMAGE_BYTES = 10_485_760;

export const HEDRA_AUDIO_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};
export const MAX_HEDRA_AUDIO_BYTES = 104_857_600;

/** Longform avatar renders take longer than Higgsfield clips. */
export const HEDRA_JOB_TIMEOUT_MS = 60 * 60_000;

/**
 * Stored as the job's request. Hedra upload handles expire after an hour, so the start image and
 * audio are kept as local paths and uploaded again on every send (including retries).
 */
export type HedraJobRequest = {
  input: { prompt: string; aspect_ratio: AspectRatio; resolution: HedraResolution };
  startImage: { filePath: string; contentType: string };
  audio: { filePath: string; contentType: string };
};

export function isHedraJobRequest(value: unknown): value is HedraJobRequest {
  const r = value as HedraJobRequest | null;
  return Boolean(r?.input?.prompt && r.startImage?.filePath && r.audio?.filePath);
}

/** Returns an error message, or null when the audio can drive a Character 3 render. */
export function checkHedraAudio(contentType: string, sizeBytes: number) {
  if (!HEDRA_AUDIO_TYPES[contentType]) return "Use an MP3, WAV or M4A audio file";
  if (sizeBytes === 0) return "The audio file is empty";
  if (sizeBytes > MAX_HEDRA_AUDIO_BYTES) return "The audio file is larger than 100 MB";
  return null;
}

export type HedraJob = {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  error?: { code?: string; message?: string } | string | null;
  outputs?: { status?: string | null; url?: string | null }[] | null;
};

/** Maps a Hedra job to the shared status shape so job tracking treats both providers alike. */
export function hedraToRemoteStatus(job: HedraJob): RemoteStatus {
  switch (job.status) {
    case "IN_QUEUE":
      return { status: "queued" };
    case "IN_PROGRESS":
      return { status: "in_progress" };
    case "COMPLETED": {
      const output = job.outputs?.find((o) => (!o.status || o.status === "COMPLETED") && o.url);
      return { status: "completed", video: output?.url ? { url: output.url } : null };
    }
    case "FAILED": {
      const error = typeof job.error === "string" ? { message: job.error } : (job.error ?? {});
      if (error.code === "MODERATION_FAILED") return { status: "nsfw" };
      return { status: "failed", error: error.message || null };
    }
  }
}
