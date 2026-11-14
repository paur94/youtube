"use client";

import {
  CheckCircle2Icon,
  SkipForwardIcon,
  StarIcon,
  UserRoundCheckIcon,
  StarOffIcon,
  Trash2Icon,
  Undo2Icon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InspectAssetButton } from "@/components/qc/qc-actions";
import { IssueCounts, QcIssueList } from "@/components/qc/qc-issue-list";
import { VisionBadge } from "@/components/qc/vision-badge";
import type { SceneOverlay } from "@/lib/overlays";
import { ASSET_SOURCE_LABELS, type AssetKind, type AssetSource, type AssetStatus } from "@/lib/production";
import type { QcIssue, VisionStatus } from "@/lib/story-qc";
import {
  deleteSceneAsset,
  reviewAsset,
  selectSceneAsset,
  sendLastFrameToNextScene,
  setSceneImageAsReference,
} from "@/server/actions/production";

import { AssetPreview } from "./asset-preview";
import { AssetStatusBadge, ModeBadge } from "./badges";
import { ImportAssetDialog } from "./import-asset-dialog";
import { useAction } from "./use-action";

export type AssetItem = {
  id: string;
  sceneId: string | null;
  kind: AssetKind;
  status: AssetStatus;
  source: AssetSource;
  provider: string;
  model: string | null;
  filePath: string | null;
  sourceUrl: string | null;
  revision: number;
  replacesRevision: number | null;
  durationSeconds: string | null;
  sizeBytes: number | null;
  createdAt: string;
  reviewNotes: string | null;
  downloadError: string | null;
  providerExpiresAt: string | null;
  prompt: string | null;
  /** Story QC vision check of this file. */
  qc: {
    status: VisionStatus;
    summary: string | null;
    issues: QcIssue[];
    dismissed: string[];
    checkedAt: string | null;
    thumbnailNote: string | null;
  };
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AssetCard({
  asset,
  isFinal,
  showSelect = true,
  canInspect = false,
  overlays,
  aspectRatio,
}: {
  asset: AssetItem;
  isFinal: boolean;
  showSelect?: boolean;
  /** Claude is configured, so the vision check can run. */
  canInspect?: boolean;
  /** The scene's text overlays, previewed over a clip. */
  overlays?: SceneOverlay[];
  /** The plan's frame format. */
  aspectRatio?: string | null;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [notes, setNotes] = useState("");
  const [pending, run] = useAction();

  return (
    <article className="grid content-start gap-2 rounded-lg border bg-background/40 p-2.5">
      <AssetPreview kind={asset.kind} filePath={asset.filePath} sourceUrl={asset.sourceUrl} overlays={overlays} aspectRatio={aspectRatio} />
      <div className="flex flex-wrap items-center gap-1.5">
        <AssetStatusBadge status={asset.status} />
        <ModeBadge mode={asset.source === "manual_import" ? "manual" : "api"} />
        <Badge variant="outline">r{asset.revision}</Badge>
        {isFinal && (
          <Badge className="bg-primary text-primary-foreground">
            <StarIcon />
            Final
          </Badge>
        )}
      </div>
      <dl className="grid gap-0.5 text-xs text-muted-foreground">
        <div>
          {ASSET_SOURCE_LABELS[asset.source]} · {asset.provider}
          {asset.model && ` · ${asset.model}`}
        </div>
        <div>
          {asset.createdAt}
          {asset.durationSeconds && ` · ${Number(asset.durationSeconds)}s`}
          {asset.sizeBytes && ` · ${formatBytes(asset.sizeBytes)}`}
        </div>
        {asset.replacesRevision && <div>Replacement for r{asset.replacesRevision}</div>}
        <div className="truncate" title={asset.filePath ?? asset.sourceUrl ?? ""}>
          {asset.filePath ? `media/${asset.filePath}` : "Not stored locally"}
        </div>
      </dl>
      {asset.downloadError && (
        <p className="text-xs text-rose-300">
          Download failed: {asset.downloadError}.
          {asset.providerExpiresAt && ` The provider link expires ${asset.providerExpiresAt}.`}
        </p>
      )}
      {asset.reviewNotes && <p className="text-xs italic text-muted-foreground">“{asset.reviewNotes}”</p>}

      {asset.sceneId && (
        <div className="grid gap-1.5 border-t pt-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <VisionBadge status={asset.qc.status} />
            {asset.filePath && canInspect && <InspectAssetButton assetId={asset.id} inspected={asset.qc.checkedAt !== null} />}
          </div>
          {asset.qc.checkedAt && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                <IssueCounts issues={asset.qc.issues} dismissed={asset.qc.dismissed} /> · {asset.qc.checkedAt}
              </summary>
              <div className="mt-2 grid gap-2">
                {asset.qc.summary && <p className="text-muted-foreground">{asset.qc.summary}</p>}
                {asset.qc.thumbnailNote && <p className="text-amber-300">Thumbnail frame: {asset.qc.thumbnailNote}</p>}
                <QcIssueList issues={asset.qc.issues} dismissed={asset.qc.dismissed} sceneId={asset.sceneId} empty="No mismatches found." />
              </div>
            </details>
          )}
        </div>
      )}

      {asset.status === "pending_review" && (
        <div className="grid gap-2 border-t pt-2">
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary"
            />
            I viewed it in full. It&apos;s safe for children, matches the characters, and doesn&apos;t copy existing
            characters or a living artist&apos;s style.
          </label>
          <Textarea
            rows={2}
            maxLength={1000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Review notes (optional)"
            className="text-xs"
          />
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              disabled={!confirmed || pending}
              onClick={() => run(() => reviewAsset(asset.id, { decision: "approved", notes }))}
            >
              <CheckCircle2Icon />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => reviewAsset(asset.id, { decision: "rejected", notes }))}
            >
              <XCircleIcon />
              Reject
            </Button>
          </div>
        </div>
      )}

      {asset.status !== "pending_review" && (
        <div className="flex flex-wrap gap-1 border-t pt-2">
          {asset.status === "approved" && showSelect && asset.sceneId && !isFinal && (
            <Button size="sm" disabled={pending} onClick={() => run(() => selectSceneAsset(asset.sceneId!, asset.id))}>
              <StarIcon />
              Use as final
            </Button>
          )}
          {isFinal && showSelect && asset.sceneId && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => selectSceneAsset(asset.sceneId!, null))}>
              <StarOffIcon />
              Unset final
            </Button>
          )}
          {asset.status === "approved" && asset.kind === "image" && asset.sceneId && asset.filePath && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title="Makes this image the primary reference of every character in the scene"
              onClick={() => run(() => setSceneImageAsReference(asset.id))}
            >
              <UserRoundCheckIcon />
              Use as character reference
            </Button>
          )}
          {asset.status === "approved" && asset.kind === "video" && asset.sceneId && asset.filePath && (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title="Saves this clip's last frame as the next scene's start image, so the cut is seamless"
              onClick={() => run(() => sendLastFrameToNextScene(asset.id))}
            >
              <SkipForwardIcon />
              Last frame to next scene
            </Button>
          )}
          {asset.status === "approved" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => reviewAsset(asset.id, { decision: "rejected" }))}
            >
              <XCircleIcon />
              Reject
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => reviewAsset(asset.id, { decision: "pending_review" }))}
          >
            <Undo2Icon />
            Back to review
          </Button>
        </div>
      )}
      {asset.sceneId && (
        <ImportAssetDialog
          target={{ sceneId: asset.sceneId }}
          replacesId={asset.id}
          label="Replace file"
          title={`Replace revision ${asset.revision}`}
          description={`Swaps in the new file as r${asset.revision} and sends it back to review. The old file stays in the media folder.`}
          variant="ghost"
        />
      )}
      {asset.sceneId && <RemoveAssetButton assetId={asset.id} revision={asset.revision} isFinal={isFinal} />}
    </article>
  );
}

function RemoveAssetButton({ assetId, revision, isFinal }: { assetId: string; revision: number; isFinal: boolean }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  return (
    <>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(true)}>
        <Trash2Icon />
        Remove from scene
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove revision {revision}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the asset record from this scene.
              {isFinal && " It is the scene's final asset, so the scene will need a new one."} The file stays in the
              media folder on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run(() => deleteSceneAsset(assetId))}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
