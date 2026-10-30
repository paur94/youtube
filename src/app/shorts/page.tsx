import { ClapperboardIcon, KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { QualitySummary, ShortStatusBadge, StandaloneBadge } from "@/components/shorts/badges";
import { AnalyzeAllButton, ImportShortsButton, SuggestOrderButton } from "@/components/shorts/studio-actions";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { evaluateQuality, summarizeQuality } from "@/lib/short-qc";
import { getClaudeConfig } from "@/server/ai/claude";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { buildQualityInput, getImportCandidates, listShorts } from "@/server/queries/shorts";

export const metadata: Metadata = { title: MODULES.shorts.label };

export default function ShortsPage() {
  return (
    <div className="grid gap-6">
      <Suspense
        fallback={
          <>
            <PageHeader title={MODULES.shorts.label} description={MODULES.shorts.description} icon={MODULES.shorts.icon} />
            <div className="grid gap-6 lg:grid-cols-3">
              <Skeleton className="h-96 rounded-xl lg:col-span-2" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </>
        }
      >
        <ShortsData />
      </Suspense>
    </div>
  );
}

async function ShortsData() {
  await connection();
  const [rows, candidates, ffmpeg] = await Promise.all([listShorts(), getImportCandidates(), getFfmpegVersion()]);
  const claude = getClaudeConfig();

  const groups = new Map<string, { planId: string | null; title: string; rows: typeof rows }>();
  for (const row of rows) {
    const key = row.short.planId ?? "none";
    if (!groups.has(key)) groups.set(key, { planId: row.short.planId, title: row.planTitle ?? "Production plan deleted", rows: [] });
    groups.get(key)!.rows.push(row);
  }
  const editable = rows.filter((r) => r.short.status !== "published").map((r) => r.short.id);

  return (
    <>
      <PageHeader title={MODULES.shorts.label} description={MODULES.shorts.description} icon={MODULES.shorts.icon}>
        <AnalyzeAllButton ids={editable} disabled={!claude.configured} />
        <ImportShortsButton plans={candidates} />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-6 lg:col-span-2">
          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                  <MODULES.shorts.icon className="size-5 text-primary" />
                </div>
                <p className="font-medium">No Shorts yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {candidates.some((p) => p.scenes.length)
                    ? "Choose Import scenes to turn your approved scene videos into Shorts, one per scene."
                    : "Approve a final video for each scene in the Production Studio first."}
                </p>
                <Button asChild variant="outline">
                  <Link href="/production">
                    <ClapperboardIcon />
                    Go to Production Studio
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            [...groups.values()].map((group) => (
              <Card key={group.planId ?? "none"}>
                <CardHeader>
                  <CardTitle>{group.title}</CardTitle>
                  <CardDescription>
                    {group.rows.length} Short{group.rows.length === 1 ? "" : "s"} · ordered by suggested publishing order
                  </CardDescription>
                  {group.planId && (
                    <CardAction>
                      <SuggestOrderButton planId={group.planId} disabled={!claude.configured || group.rows.length < 2} />
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent className="grid gap-2">
                  {group.rows.map(({ short, currentAssetId }) => {
                    const quality = summarizeQuality(
                      evaluateQuality(buildQualityInput(short, { ffmpegAvailable: Boolean(ffmpeg), hasDialogue: false })),
                    );
                    const preview = short.renderFilePath ?? short.sourceFilePath;
                    const sourceChanged = currentAssetId && short.sourceAssetId && currentAssetId !== short.sourceAssetId;
                    return (
                      <Link
                        key={short.id}
                        href={`/shorts/${short.id}`}
                        className="flex items-center gap-3 rounded-lg border p-2 transition-colors hover:border-primary/40"
                      >
                        <div className="w-10 shrink-0 text-center text-lg font-semibold text-muted-foreground tabular-nums" title="Publishing order">
                          {short.publishOrder ?? "–"}
                        </div>
                        {preview ? (
                          <video
                            src={`${mediaUrl(preview)}#t=1`}
                            muted
                            preload="metadata"
                            className={`h-20 shrink-0 rounded border bg-black object-cover ${short.renderFilePath ? "aspect-9/16" : "aspect-video"}`}
                          />
                        ) : (
                          <div className="h-20 w-12 shrink-0 rounded border" />
                        )}
                        <div className="grid min-w-0 flex-1 gap-1">
                          <p className="truncate font-medium">{short.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            Scene {short.sceneNumber}: {short.sceneTitle}
                            {short.publishOrderReason && ` · ${short.publishOrderReason}`}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ShortStatusBadge status={short.status} />
                            {short.analysis && <StandaloneBadge verdict={short.analysis.standalone.verdict} />}
                            {sourceChanged && (
                              <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                                <TriangleAlertIcon className="size-3" />
                                Scene clip replaced
                              </span>
                            )}
                            <QualitySummary summary={quality} />
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </CardContent>
              </Card>
            ))
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Tools</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm text-muted-foreground">
              <p>
                <span className="text-foreground">FFmpeg:</span>{" "}
                {ffmpeg ? `found (${ffmpeg}). Rendering and measurements are available.` : "not found."}
              </p>
              {!ffmpeg && (
                <p className="flex items-start gap-2">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                  <span>
                    Install it (free), e.g. <code className="rounded bg-muted px-1">winget install Gyan.FFmpeg</code>, then restart{" "}
                    <code className="rounded bg-muted px-1">npm run dev</code>. Or set <code className="rounded bg-muted px-1">FFMPEG_PATH</code> and{" "}
                    <code className="rounded bg-muted px-1">FFPROBE_PATH</code>.
                  </span>
                </p>
              )}
              <p>
                <span className="text-foreground">Claude:</span>{" "}
                {claude.configured ? `configured (${claude.model}).` : "not configured."}
              </p>
              {!claude.configured && (
                <p className="flex items-start gap-2">
                  <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                  Add ANTHROPIC_API_KEY to .env.local for analysis and metadata suggestions. You can still write metadata by hand.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="grid list-decimal gap-1.5 pl-4 text-sm text-muted-foreground">
                <li>Import approved scene videos: one Short per scene.</li>
                <li>Analyse with Claude: standalone strength, hook, metadata.</li>
                <li>Check framing and captions in the live preview, then render 9:16.</li>
                <li>Fix quality checks, approve the metadata, then approve the Short.</li>
                <li>Schedule it in the publishing queue and upload by hand.</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
