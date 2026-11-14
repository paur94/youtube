import { FileWarningIcon } from "lucide-react";

import type { SceneOverlay } from "@/lib/overlays";
import { type AssetKind, mediaUrl } from "@/lib/production";
import { cn } from "@/lib/utils";

import { OverlayVideo } from "./overlay-preview";

// Literal class names so Tailwind generates them. Portrait frames are capped in width so a 9:16
// preview doesn't grow taller than the screen in a wide column.
const FRAME_CLASS: Record<string, string> = {
  "16:9": "aspect-video",
  "9:16": "mx-auto aspect-9/16 max-w-xs",
  "1:1": "aspect-square",
  "4:3": "aspect-4/3",
  "3:4": "mx-auto aspect-3/4 max-w-xs",
};

/** Preview box class for a plan's aspect ratio (16:9 when unknown). */
export function frameClass(aspectRatio?: string | null) {
  return FRAME_CLASS[aspectRatio ?? ""] ?? FRAME_CLASS["16:9"];
}

/** Local file when stored, otherwise the provider URL (which may have expired). */
export function AssetPreview({
  kind,
  filePath,
  sourceUrl,
  className,
  controls = true,
  overlays,
  aspectRatio,
}: {
  kind: AssetKind;
  filePath: string | null;
  sourceUrl?: string | null;
  className?: string;
  controls?: boolean;
  /** Scene text overlays, drawn over a video as they will be burned in. */
  overlays?: SceneOverlay[];
  /** The plan's frame format, so a 9:16 scene is shown upright instead of letterboxed in 16:9. */
  aspectRatio?: string | null;
}) {
  const src = filePath ? mediaUrl(filePath) : sourceUrl;
  const box = cn("block w-full overflow-hidden rounded-md border bg-black/40", frameClass(aspectRatio), className);
  if (!src) {
    return (
      <div className={cn(box, "flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground")}>
        <FileWarningIcon className="size-4" />
        File not available
      </div>
    );
  }
  if (kind === "video" && overlays?.length) {
    return <OverlayVideo src={src} overlays={overlays} className={cn(box, "object-contain")} controls={controls} />;
  }
  if (kind === "video") {
    return (
      <video
        src={src}
        className={cn(box, "object-contain")}
        controls={controls}
        muted={!controls}
        preload="metadata"
        playsInline
      />
    );
  }
  return (
    // Local media of arbitrary size and ratio; next/image optimisation adds nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" className={cn(box, "object-contain")} />
  );
}
