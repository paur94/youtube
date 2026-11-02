import { CardAction, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeShots, type SceneContinuity } from "@/lib/story-qc";
import type { SceneQc } from "@/server/qc/service";

import { CorrectionButtons, type ReferenceCandidate, SceneReferencePicker } from "./qc-actions";
import { IssueCounts, QcIssueList } from "./qc-issue-list";

/** Pre-generation QC for one scene: script issues, shot list, corrections and extra reference images. */
export function SceneQcCard({ qc, candidates }: { qc: SceneQc; candidates: ReferenceCandidate[] }) {
  const c: SceneContinuity = qc.continuity;
  const pf = c.preflight;
  const settled = [...c.dismissed, ...(c.corrected ?? [])];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Story QC</CardTitle>
        <CardDescription className="grid gap-1">
          <IssueCounts issues={qc.state.issues} dismissed={settled} />
          <span>
            {qc.state.preflightCurrent
              ? `Script rules + Claude story check (${new Date(pf!.checkedAt).toLocaleString("en")}).`
              : qc.state.preflightStale
                ? "Script rules only: the script changed since the Claude story check. Re-check the story on the plan page."
                : "Script rules only. Run the Claude story check on the plan page for shots and continuity."}{" "}
            Critical issues block generation until they are fixed or dismissed.
          </span>
        </CardDescription>
        <CardAction>
          <CorrectionButtons sceneId={qc.scene.id} canRestore={c.promptHistory.length > 0} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <section className="grid content-start gap-2">
          <h3 className="text-sm font-medium">Issues before generation</h3>
          <QcIssueList issues={qc.state.issues} dismissed={settled} sceneId={qc.scene.id} empty="No contradictions between the script and the prompt." />
        </section>
        <div className="grid content-start gap-6">
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Shot list</h3>
            {qc.state.preflightCurrent && pf!.shots.length ? (
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-2.5 font-sans text-xs text-muted-foreground">{describeShots(pf!.shots)}</pre>
            ) : (
              <p className="text-sm text-muted-foreground">Created by the Claude story check. The vision check inspects one frame per shot.</p>
            )}
          </section>
          <section className="grid gap-2">
            <h3 className="text-sm font-medium">Scene reference images</h3>
            <SceneReferencePicker sceneId={qc.scene.id} candidates={candidates} selected={c.referenceAssetIds} />
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
