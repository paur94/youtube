import { ClapperboardIcon, SmartphoneIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { QualitySummary, ShortStatusBadge } from "@/components/shorts/badges";
import { NewVideoButton, RemoveVideoButton } from "@/components/videos/video-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { computeTimeline, evaluateVideoQuality, formatTimestamp, summarizeVideoQuality } from "@/lib/long-video";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { buildVideoQualityInput, getSceneClips, isRenderRunning, listVideos } from "@/server/queries/videos";

export const metadata: Metadata = { title: MODULES.videos.label };

export default function VideosPage() {
  return (
    <div className="grid gap-6">
      <Suspense
        fallback={
          <>
            <PageHeader title={MODULES.videos.label} description={MODULES.videos.description} icon={MODULES.videos.icon} />
            <div className="grid gap-6 lg:grid-cols-3">
              <Skeleton className="h-96 rounded-xl lg:col-span-2" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </>
        }
      >
        <VideosData />
      </Suspense>
    </div>
  );
}

async function VideosData() {
  await connection();
  const [rows, plans, ffmpeg] = await Promise.all([listVideos(), getSceneClips(), getFfmpegVersion()]);

  return (
    <>
      <PageHeader title={MODULES.videos.label} description={MODULES.videos.description} icon={MODULES.videos.icon}>
        <NewVideoButton plans={plans} />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-2 lg:col-span-2">
          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                  <MODULES.videos.icon className="size-5 text-primary" />
                </div>
                <p className="font-medium">No videos yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {plans.length
                    ? "Choose New video to combine a plan's approved scene clips into one 16:9 video."
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
            rows.map(({ video, planTitle }) => {
              const quality = summarizeVideoQuality(evaluateVideoQuality(buildVideoQualityInput(video, Boolean(ffmpeg))));
              const total = computeTimeline(video.clips, video.editSettings).total;
              const poster = video.renderFilePath ?? video.clips[0]?.filePath;
              return (
                <div key={video.id} className="flex items-center gap-3 rounded-lg border bg-card p-2 transition-colors hover:border-primary/40">
                  <Link href={`/videos/${video.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                    {poster ? (
                      <video src={`${mediaUrl(poster)}#t=1`} muted preload="metadata" className="aspect-video h-16 shrink-0 rounded border bg-black object-contain" />
                    ) : (
                      <div className="aspect-video h-16 shrink-0 rounded border" />
                    )}
                    <div className="grid min-w-0 flex-1 gap-1">
                      <p className="truncate font-medium">{video.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {planTitle ?? "Production plan deleted"} · {video.clips.length} scene{video.clips.length === 1 ? "" : "s"} ·{" "}
                        {formatTimestamp(total)}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ShortStatusBadge status={video.status} />
                        {isRenderRunning(video) && <span className="text-xs text-sky-400">Rendering {Math.round((video.renderProgress ?? 0) * 100)}%</span>}
                        {video.renderError && !isRenderRunning(video) && (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <TriangleAlertIcon className="size-3" />
                            Render failed
                          </span>
                        )}
                        <QualitySummary summary={quality} />
                      </div>
                    </div>
                  </Link>
                  <RemoveVideoButton videoId={video.id} title={video.title} published={video.status === "published" || video.youtubeVideoId !== null} compact />
                </div>
              );
            })
          )}
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm text-muted-foreground">
              <ol className="grid list-decimal gap-1.5 pl-4">
                <li>Create a video from a plan&apos;s approved scene clips.</li>
                <li>Reorder, trim or drop scenes; pick transitions and captions.</li>
                <li>Render 1920×1080 with FFmpeg (free, runs locally) and watch it.</li>
                <li>Write or suggest the metadata, approve it, then approve the video.</li>
                <li>Upload or schedule it from the Publishing page.</li>
              </ol>
              <p>
                <span className="text-foreground">FFmpeg:</span> {ffmpeg ? `found (${ffmpeg}).` : "not found: rendering is disabled."}
              </p>
              <p className="flex items-start gap-2">
                <SmartphoneIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>
                  Prefer each scene on its own? Publish them as vertical Shorts in the{" "}
                  <Link href="/shorts" className="text-primary hover:underline">
                    Shorts Studio
                  </Link>
                  . You can do both with the same scenes.
                </span>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
