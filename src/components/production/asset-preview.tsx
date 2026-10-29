import { FileWarningIcon } from "lucide-react";

import { type AssetKind, mediaUrl } from "@/lib/production";
import { cn } from "@/lib/utils";

/** Local file when stored, otherwise the provider URL (which may have expired). */
export function AssetPreview({
  kind,
  filePath,
  sourceUrl,
  className,
  controls = true,
}: {
  kind: AssetKind;
  filePath: string | null;
  sourceUrl?: string | null;
  className?: string;
  controls?: boolean;
}) {
  const src = filePath ? mediaUrl(filePath) : sourceUrl;
  const box = cn("aspect-video w-full overflow-hidden rounded-md border bg-black/40", className);
  if (!src) {
    return (
      <div className={cn(box, "flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground")}>
        <FileWarningIcon className="size-4" />
        File not available
      </div>
    );
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
