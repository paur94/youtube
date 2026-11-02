import Link from "next/link";

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { getPlanQcOverview } from "@/server/qc/service";

import { InspectPlanButton, RegenerateFailedButton, RunPreflightButton } from "./qc-actions";
import { IssueCounts } from "./qc-issue-list";
import { VisionBadge } from "./vision-badge";

type Overview = NonNullable<Awaited<ReturnType<typeof getPlanQcOverview>>>;

/** Story-to-video QC for a whole plan: before generation, after generation, and the continuity bible. */
export function PlanQcCard({ planId, overview, claudeConfigured }: { planId: string; overview: Overview; claudeConfigured: boolean }) {
  const allCurrent = Boolean(overview.bible) && overview.scenes.every((s) => s.preflightCurrent);
  const failed = overview.scenes.filter((s) => s.needsRegeneration).map((s) => s.number);
  const bible = overview.bible?.bible;
  return (
    <Card className="gap-0 overflow-hidden pb-0">
      <CardHeader className="pb-4">
        <CardTitle>Story QC</CardTitle>
        <CardDescription>
          Script rules run for free on every change. The Claude story check (one call) adds shot lists and a continuity bible; the
          vision check compares each generated clip with the story. Results are cached until the script changes.
          {!claudeConfigured && " Add ANTHROPIC_API_KEY to enable the Claude checks."}
        </CardDescription>
        <CardAction className="flex flex-wrap gap-2">
          <RunPreflightButton planId={planId} current={allCurrent} disabled={!claudeConfigured} />
          <InspectPlanButton planId={planId} disabled={!claudeConfigured} />
          <RegenerateFailedButton planId={planId} scenes={failed} />
        </CardAction>
      </CardHeader>
      <ol className="divide-y border-t">
        {overview.scenes.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
            <span className="w-6 shrink-0 text-center font-semibold text-muted-foreground tabular-nums">{s.number}</span>
            <Link href={`/production/${planId}/scenes/${s.id}`} className="min-w-0 flex-1 truncate hover:text-primary">
              {s.title}
            </Link>
            <IssueCounts issues={s.issues} dismissed={s.settled} />
            {!s.preflightCurrent && <span className="text-xs text-muted-foreground">rules only</span>}
            {s.finalVision ? <VisionBadge status={s.finalVision} /> : <span className="text-xs text-muted-foreground">no final clip</span>}
          </li>
        ))}
      </ol>
      {bible && (
        <CardContent className="border-t py-4">
          <details>
            <summary className="cursor-pointer text-sm font-medium">Continuity bible</summary>
            <div className="mt-3 grid gap-4 text-xs sm:grid-cols-3">
              <BibleList
                title="Characters"
                items={bible.characters.map((c) => ({ name: c.name, text: `${c.appearance}. Outfit: ${c.outfit}. Colours: ${c.colors.join(", ")}${c.carriedProps.length ? `. Carries: ${c.carriedProps.join(", ")}` : ""}` }))}
              />
              <BibleList
                title="Props"
                items={bible.props.map((p) => ({ name: `${p.name}${p.count !== null ? ` ×${p.count}` : ""}`, text: `${p.description} (scenes ${p.scenes.join(", ")})` }))}
              />
              <BibleList
                title="Places"
                items={bible.environments.map((e) => ({ name: e.name, text: `${e.description}. Keep: ${e.keyFeatures.join(", ")} (scenes ${e.scenes.join(", ")})` }))}
              />
            </div>
          </details>
        </CardContent>
      )}
    </Card>
  );
}

function BibleList({ title, items }: { title: string; items: { name: string; text: string }[] }) {
  return (
    <section className="grid content-start gap-1.5">
      <h4 className="font-medium">{title}</h4>
      {items.length ? (
        items.map((i) => (
          <p key={i.name} className="text-muted-foreground">
            <span className="font-medium text-foreground/90">{i.name}</span>: {i.text}
          </p>
        ))
      ) : (
        <p className="text-muted-foreground">None.</p>
      )}
    </section>
  );
}
