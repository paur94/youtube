import { ArrowLeftIcon, ClapperboardIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { ShortStoryQcCard } from "@/components/qc/short-story-qc";
import { dateTimeFormat } from "@/components/production/format";
import { CheckIcon, QualitySummary, ShortStatusBadge, StandaloneBadge } from "@/components/shorts/badges";
import { AnalyzeButton, ApplySuggestionsButton, MetadataForm, ReviewActions } from "@/components/shorts/short-actions";
import { ShortWorkbench } from "@/components/shorts/short-workbench";
import { UseCurrentClipButton } from "@/components/shorts/use-current-clip-button";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { approvalBlockers, evaluateQuality, summarizeQuality } from "@/lib/short-qc";
import { aspectLabel } from "@/lib/short-video";
import { formatCaptionLines, isShortLocked, scenesLabel } from "@/lib/shorts";
import { getClaudeConfig } from "@/server/ai/claude";
import { getOpenAIConfig } from "@/server/ai/openai";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { getShortStoryQc, shortConsistency } from "@/server/qc/service";
import { buildQualityInput, getShort, isRenderCurrent } from "@/server/queries/shorts";

export const metadata: Metadata = { title: MODULES.shorts.label };

export default function ShortPage({ params }: PageProps<"/shorts/[id]">) {
  return (
    <div className="grid gap-6">
      <Link href="/shorts" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-3.5" />
        All Shorts
      </Link>
      <Suspense
        fallback={
          <>
            <Skeleton className="h-12 w-2/3 rounded-lg" />
            <div className="grid gap-6 lg:grid-cols-3">
              <Skeleton className="h-[36rem] rounded-xl lg:col-span-2" />
              <Skeleton className="h-96 rounded-xl" />
            </div>
          </>
        }
      >
        <ShortData params={params} />
      </Suspense>
    </div>
  );
}

async function ShortData({ params }: Pick<PageProps<"/shorts/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [short, ffmpeg] = await Promise.all([getShort(id), getFfmpegVersion()]);
  if (!short) notFound();

  const claude = getClaudeConfig();
  const openai = getOpenAIConfig();
  const locked = isShortLocked(short);
  const [consistency, storyQc] = await Promise.all([shortConsistency(short), getShortStoryQc(short)]);
  const checks = evaluateQuality({
    ...buildQualityInput(short, { ffmpegAvailable: Boolean(ffmpeg), hasDialogue: [short.scene, ...short.partScenes].some((s) => (s?.dialogue.length ?? 0) > 0) }),
    consistency,
  });
  const quality = summarizeQuality(checks);
  const blockers = approvalBlockers(checks, { rendered: Boolean(short.renderFilePath), metadataApproved: Boolean(short.metadataApprovedAt) });
  const probe = short.sourceProbe;
  const sourceLabel = probe?.width
    ? `${probe.width}×${probe.height} (${aspectLabel(probe.width, probe.height)}) · ${probe.durationSeconds ?? "?"}s`
    : "not measured";
  const a = short.analysis;
  const planHref = short.plan ? `/production/${short.plan.id}` : null;

  return (
    <>
      <PageHeader title={short.title} description={`${scenesLabel(short)} of ${short.plan?.title ?? "a deleted plan"}: ${short.sceneTitle}`}>
        <ShortStatusBadge status={short.status} />
        {a && <StandaloneBadge verdict={a.standalone.verdict} />}
        {planHref && short.scene && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${planHref}/scenes/${short.scene.id}`}>
              <ClapperboardIcon />
              Production scene
            </Link>
          </Button>
        )}
      </PageHeader>

      {short.sourceChanged && !locked && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
            {short.parts?.length
              ? "A merged scene's final clip was replaced in the Production Studio after this Short was made."
              : "The scene's final clip was replaced in the Production Studio after this Short was imported."}
          </p>
          <UseCurrentClipButton shortId={short.id} />
        </div>
      )}
      {short.status === "failed" && short.publishError && (
        <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm">Upload failed: {short.publishError}</div>
      )}
      {short.status === "rejected" && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">
          Rejected{short.reviewNotes ? `: ${short.reviewNotes}` : "."}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent>
            <ShortWorkbench
              key={`${short.updatedAt.toISOString()}`}
              shortId={short.id}
              locked={locked}
              sourceUrl={short.sourceFilePath ? mediaUrl(short.sourceFilePath) : null}
              sourceLabel={sourceLabel}
              renderUrl={short.renderFilePath ? mediaUrl(short.renderFilePath) : null}
              renderCurrent={isRenderCurrent(short)}
              renderedLabel={short.renderedAt ? dateTimeFormat.format(short.renderedAt) : null}
              renderError={short.renderError}
              settings={short.videoSettings}
              captionsText={formatCaptionLines(short.captions)}
              captionsReviewed={short.captionsReviewed}
              overlays={short.overlays}
              durationSeconds={probe?.durationSeconds ?? null}
              hook={short.hook}
              hookSeconds={short.hookSeconds}
              ffmpegAvailable={Boolean(ffmpeg)}
            />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Quality control</CardTitle>
              <CardDescription>
                <QualitySummary summary={quality} />
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-3">
                {checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <CheckIcon status={c.status} className="mt-0.5" />
                    <div className="grid gap-0.5">
                      <p className="font-medium">{c.label}</p>
                      {c.details.map((d) => (
                        <p key={d} className="text-xs text-muted-foreground">
                          {d}
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Review</CardTitle>
              <CardDescription>Approval needs a current render, approved metadata and no failed checks, including story consistency.</CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewActions shortId={short.id} status={short.status} uploaded={short.youtubeVideoId !== null} blockers={blockers} title={short.title} />
            </CardContent>
          </Card>
        </div>
      </div>

      {storyQc && <ShortStoryQcCard qc={storyQc} sourceAssetId={short.sourceAssetId} canInspect={claude.configured} locked={locked} />}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
            <CardDescription>
              {short.metadataApprovedAt ? `Approved ${dateTimeFormat.format(short.metadataApprovedAt)}` : "Not approved yet"}
              {short.publishOrderReason && ` · Order: ${short.publishOrderReason}`}
            </CardDescription>
            <CardAction className="flex flex-wrap gap-2">
              {a && <ApplySuggestionsButton shortId={short.id} disabled={locked} />}
              <AnalyzeButton shortId={short.id} analyzed={Boolean(a)} disabled={locked || !openai.configured} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <MetadataForm
              shortId={short.id}
              formKey={short.updatedAt.toISOString()}
              locked={locked}
              approved={Boolean(short.metadataApprovedAt)}
              values={{
                title: short.title,
                description: short.description,
                hashtags: short.hashtags,
                playlist: short.playlist,
                hook: short.hook,
                hookSeconds: short.hookSeconds,
                publishOrder: short.publishOrder,
                notes: short.notes,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
