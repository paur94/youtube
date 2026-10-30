import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { SampleDataButton } from "@/components/ideas/sample-data-button";
import { PageHeader } from "@/components/page-header";
import { dateTimeFormat } from "@/components/production/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectYouTubeButton, DisconnectYouTubeButton } from "@/components/youtube/connection-actions";
import { SAMPLE_IDEAS } from "@/lib/sample-ideas";
import { MODULES } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { parseConnectOutcome, YOUTUBE_CONNECT_OUTCOMES } from "@/lib/youtube";
import { getClaudeConfig } from "@/server/ai/claude";
import { getFfmpegVersion } from "@/server/media/ffmpeg";
import { getMediaRoot } from "@/server/media/storage";
import { getHedraConfig } from "@/server/providers/hedra";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import { getYouTubeConfig } from "@/server/providers/youtube";
import { getSampleIdeaCount } from "@/server/queries/ideas";
import { getYouTubeConnection } from "@/server/youtube/connection";

export const metadata: Metadata = { title: MODULES.settings.label };

export default function SettingsPage({ searchParams }: PageProps<"/settings">) {
  return (
    <div className="grid gap-6">
      <PageHeader
        title={MODULES.settings.label}
        description={MODULES.settings.description}
        icon={MODULES.settings.icon}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>YouTube channel</CardTitle>
            <CardDescription>
              Lets you upload approved Shorts from the Publishing page. Only uploads you start and confirm are made: nothing is
              published automatically. Credentials and tokens stay on this server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-16 rounded-lg" />}>
              <YouTubeStatus searchParams={searchParams} />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sample data</CardTitle>
            <CardDescription>
              {SAMPLE_IDEAS.length} fictional demo ideas for exploring the app. They are marked with
              a “Sample” badge and stored in the database like any other idea.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-16 rounded-lg" />}>
              <SampleDataStatus />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>Current configuration of this local installation</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm">
              <Row label="Storage" value="PostgreSQL (Docker, localhost:5440)" />
              <Row label="Authentication" value="None. Run on localhost only." />
              <Suspense fallback={<Row label="Claude API" value="…" />}>
                <ClaudeStatus />
              </Suspense>
              <Suspense fallback={<Row label="Higgsfield API" value="…" />}>
                <ProductionStatus />
              </Suspense>
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

async function SampleDataStatus() {
  await connection();
  const count = await getSampleIdeaCount();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/40 p-3">
      <p className="text-sm">
        {count > 0 ? (
          <>
            <span className="font-medium tabular-nums">{count}</span> sample ideas loaded
          </>
        ) : (
          <span className="text-muted-foreground">No sample ideas loaded</span>
        )}
      </p>
      {count > 0 ? (
        <SampleDataButton mode="remove" variant="destructive" />
      ) : (
        <SampleDataButton mode="load" variant="default" />
      )}
    </div>
  );
}

async function ClaudeStatus() {
  // Read at request time so changing .env.local only needs a server restart, not a rebuild.
  await connection();
  const claude = getClaudeConfig();
  return (
    <Row
      label="Claude API"
      value={claude.configured ? `Configured · ${claude.model}` : "Not configured (set ANTHROPIC_API_KEY)"}
    />
  );
}

async function ProductionStatus() {
  await connection();
  const higgsfield = getHiggsfieldConfig();
  const ffmpeg = await getFfmpegVersion();
  return (
    <>
      <Row
        label="Higgsfield API"
        value={higgsfield.configured ? "Configured" : "Not configured (manual workflow)"}
      />
      <Row
        label="Hedra API (Character 3)"
        value={getHedraConfig().configured ? "Configured" : "Not configured (set HEDRA_API_KEY)"}
      />
      <Row label="Media folder" value={getMediaRoot()} />
      <Row label="FFmpeg (Shorts rendering)" value={ffmpeg ? `Found · ${ffmpeg}` : "Not found (install FFmpeg or set FFMPEG_PATH)"} />
    </>
  );
}

async function YouTubeStatus({ searchParams }: Pick<PageProps<"/settings">, "searchParams">) {
  await connection();
  const outcome = parseConnectOutcome((await searchParams).youtube);
  const config = getYouTubeConfig();
  const channel = config.configured ? await getYouTubeConnection() : null;
  const notice = outcome ? YOUTUBE_CONNECT_OUTCOMES[outcome] : null;

  return (
    <div className="grid gap-3">
      {notice && (
        <p
          role="status"
          className={cn(
            "rounded-lg border p-3 text-sm",
            notice.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-rose-500/40 bg-rose-500/10",
          )}
        >
          {notice.message}
        </p>
      )}
      {!config.configured ? (
        <div className="grid gap-2 rounded-lg border bg-background/40 p-3 text-sm">
          <p>
            Not configured. Missing in <code>.env.local</code>: {config.missing.join(", ")}.
          </p>
          <p className="text-muted-foreground">
            Create a “Web application” OAuth client in Google Cloud Console with the YouTube Data API v3 enabled, and add{" "}
            <code>{"<this app's origin>"}/api/youtube/callback</code> as an authorized redirect URI. See the README.
          </p>
        </div>
      ) : channel ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/40 p-3">
          <div className="flex items-center gap-3">
            {channel.thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no image optimisation needed
              <img src={channel.thumbnailUrl} alt="" className="size-10 rounded-full" referrerPolicy="no-referrer" />
            )}
            <div className="text-sm">
              <p className="font-medium">{channel.channelTitle}</p>
              <p className="text-muted-foreground">
                {channel.channelHandle ?? channel.channelId} · connected {dateTimeFormat.format(channel.connectedAt)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ConnectYouTubeButton reconnect />
            <DisconnectYouTubeButton channelTitle={channel.channelTitle} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/40 p-3">
          <p className="text-sm text-muted-foreground">No channel connected. You&apos;ll choose the channel on Google&apos;s consent screen.</p>
          <ConnectYouTubeButton />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 border-b pb-3 last:border-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
