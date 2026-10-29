import { FlaskConicalIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  ORIGINALITY_LABELS,
  STATUS_LABELS,
  type IdeaStatus,
  type OriginalityStatus,
} from "@/lib/ideas";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<IdeaStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  approved: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  scripted: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  generated: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  archived: "bg-transparent text-muted-foreground border-border line-through",
};

export function StatusBadge({ status }: { status: IdeaStatus }) {
  return <Badge className={cn(STATUS_STYLES[status])}>{STATUS_LABELS[status]}</Badge>;
}

const ORIGINALITY_STYLES: Record<OriginalityStatus, string> = {
  not_reviewed: "border-border bg-transparent text-muted-foreground",
  in_review: "border-sky-500/30 bg-transparent text-sky-300",
  original: "border-emerald-500/30 bg-transparent text-emerald-300",
  needs_changes: "border-rose-500/40 bg-transparent text-rose-300",
};

export function OriginalityBadge({ status }: { status: OriginalityStatus }) {
  return (
    <Badge variant="outline" className={cn(ORIGINALITY_STYLES[status])}>
      {ORIGINALITY_LABELS[status]}
    </Badge>
  );
}

export function SampleBadge() {
  return (
    <Badge
      variant="outline"
      className="h-4 border-amber-500/40 px-1.5 text-[10px] text-amber-300"
      title="Sample data — remove it from Settings"
    >
      <FlaskConicalIcon />
      Sample
    </Badge>
  );
}
