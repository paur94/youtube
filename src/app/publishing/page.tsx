import { InfoIcon, SmartphoneIcon, TriangleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { dateTimeFormat } from "@/components/production/format";
import { ShortStatusBadge } from "@/components/shorts/badges";
import { QueueActions, YouTubeMetadataButton } from "@/components/shorts/queue-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { buildYouTubeMetadata, isOverdue, SHORT_STATUS_LABELS, SHORT_STATUSES } from "@/lib/shorts";
import { getYouTubeConfig } from "@/server/providers/youtube";
import { getPublishingQueue, getShortStatusCounts, isRenderCurrent } from "@/server/queries/shorts";
import { getYouTubeConnection } from "@/server/youtube/connection";

export const metadata: Metadata = { title: MODULES.publishing.label };

export default function PublishingPage() {
  return (
    <div className="grid gap-6">
      <PageHeader title={MODULES.publishing.label} description={MODULES.publishing.description} icon={MODULES.publishing.icon} />
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <QueueData />
      </Suspense>
    </div>
  );
}

async function QueueData() {
  await connection();
  const youtube = getYouTubeConfig();
  const [queue, counts, channel] = await Promise.all([
    getPublishingQueue(),
    getShortStatusCounts(),
    youtube.configured ? getYouTubeConnection() : null,
  ]);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {SHORT_STATUSES.map((s) => (
          <Card key={s} className="gap-1 py-3">
            <CardContent className="px-4">
              <p className="text-2xl font-semibold tabular-nums">{counts[s] ?? 0}</p>
              <p className="text-xs text-muted-foreground">{SHORT_STATUS_LABELS[s]}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm text-muted-foreground">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>
          Nothing is published automatically. A Short reaches YouTube only when you choose “Upload to YouTube” and confirm it,
          and only after it was approved in the Shorts Studio.{" "}
          {channel ? (
            <>
              Uploads go to <span className="font-medium text-foreground">{channel.channelTitle}</span>.
            </>
          ) : (
            <>
              No channel is connected:{" "}
              <Link href="/settings" className="text-primary hover:underline">
                connect one in Settings
              </Link>
              , or upload in YouTube Studio and mark it published here.
            </>
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Publishing queue</CardTitle>
          <CardDescription>Approved, scheduled, failed and published Shorts. Review and approve drafts in the Shorts Studio.</CardDescription>
        </CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
              <p>No approved Shorts yet.</p>
              <Button asChild variant="outline">
                <Link href="/shorts">
                  <SmartphoneIcon />
                  Go to Shorts Studio
                </Link>
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Short</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.map(({ short, planTitle, storyLanguage, madeForKids, containsSyntheticMedia }) => {
                  const yt = buildYouTubeMetadata({
                    title: short.title,
                    description: short.description,
                    hashtags: short.hashtags,
                    playlist: short.playlist,
                    language: storyLanguage,
                    madeForKids: madeForKids ?? true,
                    containsSyntheticMedia: containsSyntheticMedia ?? true,
                    scheduledAt: short.scheduledAt,
                    hasCaptions: short.captions.length > 0,
                  });
                  const overdue = isOverdue(short.status, short.scheduledAt);
                  const stale = !isRenderCurrent(short);
                  return (
                    <TableRow key={short.id}>
                      <TableCell className="text-muted-foreground tabular-nums">{short.publishOrder ?? "–"}</TableCell>
                      <TableCell className="max-w-72">
                        <Link href={`/shorts/${short.id}`} className="block truncate font-medium hover:underline">
                          {short.title}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {planTitle ?? "Plan deleted"} · scene {short.sceneNumber}
                          {short.playlist && ` · ${short.playlist}`}
                        </p>
                        {short.status === "failed" && short.publishError && (
                          <p className="text-xs whitespace-normal text-orange-400">{short.publishError}</p>
                        )}
                        {stale && short.status !== "published" && (
                          <p className="flex items-center gap-1 text-xs text-amber-400">
                            <TriangleAlertIcon className="size-3" />
                            Render out of date
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <ShortStatusBadge status={short.status} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {short.status === "published" ? (
                          <span>
                            {short.publishedAt ? dateTimeFormat.format(short.publishedAt) : "Published"}
                            {short.youtubeUrl && (
                              <a href={short.youtubeUrl} target="_blank" rel="noreferrer" className="block text-xs text-primary hover:underline">
                                Open on YouTube
                              </a>
                            )}
                          </span>
                        ) : short.scheduledAt ? (
                          <span className={overdue ? "text-amber-400" : undefined}>
                            {dateTimeFormat.format(short.scheduledAt)}
                            <span className="block text-xs text-muted-foreground">
                              {short.youtubeVideoId ? "Uploaded · YouTube publishes it" : "Not uploaded yet"}
                            </span>
                            {overdue && (
                              <span className="block text-xs">{short.youtubeVideoId ? "Time passed: check YouTube" : "Time passed: published yet?"}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not scheduled</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <YouTubeMetadataButton
                            title={yt.snippet.title}
                            description={yt.snippet.description}
                            tags={yt.snippet.tags.join(", ")}
                            json={JSON.stringify(yt, null, 2)}
                            checklist={[
                              `Audience: ${yt.status.selfDeclaredMadeForKids ? "Yes, it's made for kids" : "No, it's not made for kids"}`,
                              `Altered or synthetic content: ${yt.status.containsSyntheticMedia ? "Yes" : "No"}`,
                              `Visibility: ${short.scheduledAt ? `Schedule for ${dateTimeFormat.format(short.scheduledAt)}` : "Private until you're ready"}`,
                              ...(yt.extras.playlist ? [`Playlist: ${yt.extras.playlist}`] : []),
                              ...(short.captions.length
                                ? [short.videoSettings.burnCaptions ? "Captions are burned in; uploading the .srt as well is optional" : "Upload the .srt as a caption track"]
                                : []),
                              "Category: Film & Animation (or Education)",
                            ]}
                            videoUrl={short.renderFilePath ? mediaUrl(short.renderFilePath) : null}
                            captionsUrl={short.captions.length ? `/api/shorts/${short.id}/captions` : null}
                          />
                          <QueueActions
                            shortId={short.id}
                            title={short.title}
                            status={short.status}
                            scheduledAt={short.scheduledAt?.toISOString() ?? null}
                            uploaded={short.youtubeVideoId !== null}
                            channelTitle={channel?.channelTitle ?? null}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
