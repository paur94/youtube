import { createHash } from "node:crypto";

import { ArrowLeftIcon, ClapperboardIcon, DownloadIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { dateTimeFormat } from "@/components/production/format";
import { CheckIcon, QualitySummary, ShortStatusBadge } from "@/components/shorts/badges";
import { SuggestMetadataButton, VideoMetadataForm, VideoReviewActions } from "@/components/videos/video-actions";
import { VideoEditor } from "@/components/videos/video-editor";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildChapters,
  computeTimeline,
  evaluateVideoQuality,
  isVideoLocked,
  summarizeVideoQuality,
  videoApprovalBlockers,
} from "@/lib/long-video";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { getClaudeConfig } from "@/server/ai/claude";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { buildVideoQualityInput, getVideo, isRenderRunning, isVideoRenderCurrent } from "@/server/queries/videos";

export const metadata: Metadata = { title: MODULES.videos.label };

export default function VideoPage({ params }: PageProps<"/videos/[id]">) {
  return (
    <div className="grid gap-6">
      <Link href="/videos" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-3.5" />
        All videos
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
        <VideoData params={params} />
      </Suspense>
    </div>
  );
}

async function VideoData({ params }: Pick<PageProps<"/videos/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [video, ffmpeg] = await Promise.all([getVideo(id), getFfmpegVersion()]);
  if (!video) notFound();

  const claude = getClaudeConfig();
  const locked = isVideoLocked(video);
  const checks = evaluateVideoQuality(buildVideoQualityInput(video, Boolean(ffmpeg)));
  const blockers = videoApprovalBlockers(checks, { rendered: Boolean(video.renderFilePath), metadataApproved: Boolean(video.metadataApprovedAt) });
  const chapters = video.editSettings.chapters ? buildChapters(video.clips, computeTimeline(video.clips, video.editSettings)) : null;
  const running = isRenderRunning(video);
  // Remounts the editor when the saved edit changes, but not on every progress tick of a render.
  const editKey = createHash("sha1").update(JSON.stringify([video.clips, video.editSettings, video.captionsReviewed])).digest("hex");
  const metadataKey = createHash("sha1")
    .update(JSON.stringify([video.title, video.description, video.hashtags, video.playlist, video.notes, video.metadataApprovedAt]))
    .digest("hex");
  const hasCaptions = video.clips.some((c) => c.captions.length > 0);

  return (
    <>
      <PageHeader title={video.title} description={`16:9 video from ${video.plan?.title ?? "a deleted production plan"}`}>
        <ShortStatusBadge status={video.status} />
        {video.plan && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/production/${video.plan.id}`}>
              <ClapperboardIcon />
              Production plan
            </Link>
          </Button>
        )}
      </PageHeader>

      {video.status === "failed" && video.publishError && (
        <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-sm">Upload failed: {video.publishError}</div>
      )}
      {video.status === "rejected" && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">Rejected{video.reviewNotes ? `: ${video.reviewNotes}` : "."}</div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent>
            <VideoEditor
              key={editKey}
              videoId={video.id}
              locked={locked}
              clips={video.clips}
              available={video.sceneClips.flatMap((s) => (s.filePath ? [{ ...s, filePath: s.filePath }] : []))}
              settings={video.editSettings}
              captionsReviewed={video.captionsReviewed}
              replacedCount={video.replacedClips.length}
              ffmpegAvailable={Boolean(ffmpeg)}
              render={{
                url: video.renderFilePath ? mediaUrl(video.renderFilePath) : null,
                current: isVideoRenderCurrent(video),
                label: video.renderedAt ? dateTimeFormat.format(video.renderedAt) : null,
                error: video.renderError,
                running,
                progress: video.renderProgress,
              }}
            />
          </CardContent>
        </Card>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Quality control</CardTitle>
              <CardDescription>
                <QualitySummary summary={summarizeVideoQuality(checks)} />
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
              {hasCaptions && (
                <Button asChild variant="ghost" size="sm" className="mt-3">
                  <a href={`/api/videos/${video.id}/captions`}>
                    <DownloadIcon />
                    Captions (.srt)
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Review</CardTitle>
              <CardDescription>Approval needs a current render, approved metadata and no failed checks.</CardDescription>
            </CardHeader>
            <CardContent>
              <VideoReviewActions
                videoId={video.id}
                status={video.status}
                uploaded={video.youtubeVideoId !== null}
                blockers={running ? ["Wait for the render to finish.", ...blockers] : blockers}
                title={video.title}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
            <CardDescription>{video.metadataApprovedAt ? `Approved ${dateTimeFormat.format(video.metadataApprovedAt)}` : "Not approved yet"}</CardDescription>
            <CardAction>
              <SuggestMetadataButton videoId={video.id} disabled={locked || !claude.configured} />
            </CardAction>
          </CardHeader>
          <CardContent>
            <VideoMetadataForm
              videoId={video.id}
              formKey={metadataKey}
              locked={locked}
              approved={Boolean(video.metadataApprovedAt)}
              chapters={chapters}
              values={{ title: video.title, description: video.description, hashtags: video.hashtags, playlist: video.playlist, notes: video.notes }}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
