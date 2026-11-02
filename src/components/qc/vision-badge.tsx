import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, HistoryIcon, TriangleAlertIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { VISION_STATUS_LABELS, type VisionStatus } from "@/lib/story-qc";
import { cn } from "@/lib/utils";

const STYLES: Record<VisionStatus, string> = {
  unchecked: "bg-muted text-muted-foreground",
  stale: "bg-muted text-muted-foreground",
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  fail: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

const ICONS = { unchecked: CircleDashedIcon, stale: HistoryIcon, pass: CircleCheckIcon, warn: TriangleAlertIcon, fail: CircleXIcon };

export function VisionBadge({ status, className }: { status: VisionStatus; className?: string }) {
  const Icon = ICONS[status];
  return (
    <Badge variant="outline" className={cn("border-transparent", STYLES[status], className)}>
      <Icon />
      {VISION_STATUS_LABELS[status]}
    </Badge>
  );
}
