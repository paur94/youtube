import { ClapperboardIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSeconds } from "@/lib/story-qc";
import type { getShortStoryQc } from "@/server/qc/service";

import { InspectAssetButton } from "./qc-actions";
import { IssueCounts, QcIssueList } from "./qc-issue-list";
import { VisionBadge } from "./vision-badge";

type StoryQc = NonNullable<Awaited<ReturnType<typeof getShortStoryQc>>>;

/** Shorts Studio view of the story QC: script issues and the vision check of the exact source clip. */
export function ShortStoryQcCard({
  qc,
  sourceAssetId,
  canInspect,
  locked,
}: {
  qc: StoryQc;
  sourceAssetId: string | null;
  canInspect: boolean;
  locked: boolean;
}) {
  const r = qc.report;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Story consistency</CardTitle>
        <CardDescription className="grid gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <VisionBadge status={qc.status} />
            {r && <IssueCounts issues={r.issues} dismissed={qc.dismissed} />}
          </span>
          <span>
            Critical mismatches block approval and upload. Fix them in the production scene (corrections and regeneration keep the current clip until a
            replacement passes), or dismiss an issue after checking it yourself.
          </span>
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          {sourceAssetId && canInspect && !locked && <InspectAssetButton assetId={sourceAssetId} inspected={Boolean(r)} />}
          <Button asChild size="sm" variant="outline">
            <Link href={`/production/${qc.planId}/scenes/${qc.sceneId}`}>
              <ClapperboardIcon />
              Fix in scene
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <section className="grid content-start gap-2">
          <h3 className="text-sm font-medium">Generated clip vs story</h3>
          {r ? (
            <>
              {r.summary && <p className="text-sm text-muted-foreground">{r.summary}</p>}
              <p className={r.thumbnail.ok ? "text-xs text-muted-foreground" : "text-xs text-amber-300"}>
                Thumbnail frame at {formatSeconds(r.thumbnail.time)}: {r.thumbnail.ok ? "usable" : r.thumbnail.note}
              </p>
              <QcIssueList issues={r.issues} dismissed={qc.dismissed} sceneId={qc.sceneId} empty="No mismatches between the clip and the story." />
              {r.frames.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">What the check saw ({r.frames.length} frames)</summary>
                  <ul className="mt-2 grid gap-1 text-muted-foreground">
                    {r.frames.map((f) => (
                      <li key={f.time}>
                        <span className="font-mono">{formatSeconds(f.time)}</span> {f.description}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not inspected yet. The vision check extracts a frame per shot and compares it with the dialogue, actions, counts, directions and
              character references.
            </p>
          )}
        </section>
        <section className="grid content-start gap-2">
          <h3 className="text-sm font-medium">Script issues</h3>
          <QcIssueList issues={qc.preflightIssues} dismissed={qc.settled} sceneId={qc.sceneId} empty="No contradictions in the script." />
        </section>
      </CardContent>
    </Card>
  );
}
