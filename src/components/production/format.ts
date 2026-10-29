import type { Asset, GenerationJob } from "@/db/schema";
import { getHiggsfieldModel } from "@/lib/higgsfield";

import type { AssetItem } from "./asset-card";
import type { JobItem } from "./job-list";

export const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** Serialisable props for <AssetCard>. `revisionOf` maps asset ids to revision numbers. */
export function toAssetItem(asset: Asset, revisionOf: (id: string) => number | undefined = () => undefined): AssetItem {
  const meta = asset.metadata ?? {};
  const expires = typeof meta.providerExpiresAt === "string" ? new Date(meta.providerExpiresAt) : null;
  return {
    id: asset.id,
    sceneId: asset.sceneId,
    kind: asset.kind,
    status: asset.status,
    source: asset.source,
    provider: asset.provider,
    model: asset.model ? (getHiggsfieldModel(asset.model)?.label ?? asset.model) : null,
    filePath: asset.filePath,
    sourceUrl: asset.sourceUrl,
    revision: asset.revision,
    replacesRevision: asset.replacesId ? (revisionOf(asset.replacesId) ?? null) : null,
    durationSeconds: asset.durationSeconds,
    sizeBytes: asset.sizeBytes,
    createdAt: dateTimeFormat.format(asset.createdAt),
    reviewNotes: asset.reviewNotes,
    downloadError: typeof meta.downloadError === "string" ? meta.downloadError : null,
    providerExpiresAt: expires && !Number.isNaN(expires.getTime()) ? dateTimeFormat.format(expires) : null,
    prompt: asset.prompt,
  };
}

export function toJobItem(job: GenerationJob): JobItem {
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    modelLabel: job.model ? (getHiggsfieldModel(job.model)?.label ?? job.model) : "Higgsfield web app",
    outputKind: job.outputKind,
    attempt: job.attempt,
    createdAt: dateTimeFormat.format(job.createdAt),
    estimatedCostUsd: job.estimatedCostUsd,
    error: job.error,
    externalRequestId: job.externalRequestId,
    outputExpiresAt: job.outputExpiresAt ? dateTimeFormat.format(job.outputExpiresAt) : null,
  };
}
