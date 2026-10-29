import { Badge } from "@/components/ui/badge";
import { STORY_STATUS_LABELS, type StoryStatus } from "@/lib/stories";
import { cn } from "@/lib/utils";

const STORY_STATUS_STYLES: Record<StoryStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  review: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
};

export function StoryStatusBadge({ status }: { status: StoryStatus }) {
  return <Badge className={cn(STORY_STATUS_STYLES[status])}>{STORY_STATUS_LABELS[status]}</Badge>;
}
