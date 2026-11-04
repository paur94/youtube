import type { RemoteStatus } from "./generation-jobs";
import type { HiggsfieldModel } from "./higgsfield";

// Replicate predictions API (https://replicate.com/docs/reference/http). Only Wan 3.0 is used through it
// (https://replicate.com/alibaba/wan-3, schema checked November 2026); its models live in HIGGSFIELD_MODELS
// with provider "replicate" so the model pickers list them alongside Higgsfield's.
export const REPLICATE_PROVIDER = "replicate";

/** Replicate deletes the outputs of API predictions an hour after they finish. */
export const REPLICATE_OUTPUT_TTL_MS = 60 * 60_000;

export type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled" | "aborted";
  output?: string | string[] | null;
  error?: string | null;
  completed_at?: string | null;
};

/** Maps a prediction to the shared status shape so job tracking treats every provider alike. */
export function replicateToRemoteStatus(prediction: ReplicatePrediction): RemoteStatus {
  switch (prediction.status) {
    case "starting":
      return { status: "queued" };
    case "processing":
      return { status: "in_progress" };
    case "succeeded": {
      const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
      const completed = prediction.completed_at ? new Date(prediction.completed_at).getTime() : NaN;
      return {
        status: "completed",
        video: url ? { url } : null,
        expires_at: Number.isNaN(completed) ? null : new Date(completed + REPLICATE_OUTPUT_TTL_MS).toISOString(),
      };
    }
    case "failed":
      // E005 is Replicate's "flagged as sensitive" moderation error.
      if (prediction.error && /E005|sensitive|nsfw/i.test(prediction.error)) return { status: "nsfw" };
      return { status: "failed", error: prediction.error || null };
    case "canceled":
    case "aborted":
      return { status: "canceled" };
  }
}

/** Replicate bills Wan 3.0 per second of output, so the estimate is computed locally. */
export function estimateReplicateCost(model: HiggsfieldModel, body: Record<string, unknown>) {
  if (!model.usdPerSecond || typeof body.duration !== "number") return null;
  return Math.round(model.usdPerSecond * body.duration * 10_000) / 10_000;
}
