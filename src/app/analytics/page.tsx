import { InfoIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header";
import { ShortStatusBadge } from "@/components/shorts/badges";
import { AddMetricsButton, DeleteMetricsButton } from "@/components/shorts/metrics-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ShortMetric } from "@/db/schema";
import { MODULES } from "@/lib/navigation";
import { type MetricKey, metricState, SHORT_METRICS, TRAFFIC_SOURCE_LABELS, type TrafficSource } from "@/lib/shorts";
import { getShortAnalytics } from "@/server/queries/shorts";

export const metadata: Metadata = { title: MODULES.analytics.label };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat("en");

export default function AnalyticsPage() {
  return (
    <div className="grid gap-6">
      <PageHeader title={MODULES.analytics.label} description={MODULES.analytics.description} icon={MODULES.analytics.icon} />
      <AvailabilityCard />
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <AnalyticsData />
      </Suspense>
    </div>
  );
}

function AvailabilityCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What can be tracked</CardTitle>
        <CardDescription>
          No YouTube account is connected, so every number here is entered by hand from YouTube Studio. The table shows where
          each metric lives and whether YouTube&apos;s Analytics API offers it for a later automatic import.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metric</TableHead>
              <TableHead>In this app</TableHead>
              <TableHead>In YouTube Studio</TableHead>
              <TableHead>YouTube Analytics API</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SHORT_METRICS.map((m) => (
              <TableRow key={m.key}>
                <TableCell className="font-medium">{m.label}</TableCell>
                <TableCell>
                  <Badge variant="outline">Manual entry</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{m.studio}</TableCell>
                <TableCell className="text-xs">
                  {m.api ? (
                    <code className="rounded bg-muted px-1">{m.api}</code>
                  ) : (
                    <span className="text-amber-400">Not offered: Studio only</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          Availability as documented when this milestone was built (October 2026); YouTube changes these. Made-for-kids videos
          have some features turned off (such as comments), so check what Studio shows for your channel.
        </p>
      </CardContent>
    </Card>
  );
}

function formatValue(key: MetricKey, metric: ShortMetric) {
  switch (key) {
    case "views":
    case "likes":
    case "subscribersGained":
      return metric[key] === null ? null : numberFormat.format(metric[key]);
    case "averageViewDurationSeconds":
      return metric[key] === null ? null : `${metric[key].toFixed(1)}s`;
    case "viewedPercent":
    case "averagePercentageViewed":
      return metric[key] === null ? null : `${metric[key].toFixed(1)}%`;
    case "trafficSources": {
      const sources = metric.trafficSources;
      if (!sources || !Object.keys(sources).length) return null;
      return Object.entries(sources)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([s, v]) => `${TRAFFIC_SOURCE_LABELS[s as TrafficSource]} ${v}%`)
        .join(", ");
    }
  }
}

const EMPTY_LABEL = { not_published: "not published", not_entered: "not entered" } as const;

async function AnalyticsData() {
  await connection();
  const rows = await getShortAnalytics();
  const published = rows.filter((r) => r.status === "published");

  if (!rows.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No Shorts yet. Create them in the{" "}
          <Link href="/shorts" className="text-primary hover:underline">
            Shorts Studio
          </Link>
          .
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Per-Short performance</CardTitle>
          <CardDescription>
            Latest snapshot per Short. {published.length} of {rows.length} published. Empty cells say why they are empty.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Short</TableHead>
                {SHORT_METRICS.map((m) => (
                  <TableHead key={m.key} className="text-right">
                    {m.label}
                  </TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isPublished = row.status === "published";
                return (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-56">
                      <Link href={`/shorts/${row.id}`} className="block truncate font-medium hover:underline">
                        {row.title}
                      </Link>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ShortStatusBadge status={row.status} />
                        {row.latest && `as of ${dateFormat.format(row.latest.capturedAt)}`}
                      </div>
                    </TableCell>
                    {SHORT_METRICS.map((m) => {
                      const value = row.latest ? formatValue(m.key, row.latest) : null;
                      const state = metricState(isPublished, value);
                      return (
                        <TableCell key={m.key} className="text-right tabular-nums">
                          {state === "value" ? value : <span className="text-xs text-muted-foreground">{EMPTY_LABEL[state]}</span>}
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-right">{isPublished && <AddMetricsButton shortId={row.id} title={row.title} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {published.some((r) => r.history.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Snapshot history</CardTitle>
            <CardDescription>Every snapshot you entered, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {published
              .filter((r) => r.history.length)
              .map((r) => (
                <div key={r.id} className="grid gap-1">
                  <p className="text-sm font-medium">{r.title}</p>
                  {r.history.map((m) => (
                    <div key={m.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs text-muted-foreground">
                      <span>
                        {dateFormat.format(m.capturedAt)} ·{" "}
                        {SHORT_METRICS.map((d) => [d.label, formatValue(d.key, m)] as const)
                          .filter(([, v]) => v !== null)
                          .map(([l, v]) => `${l}: ${v}`)
                          .join(" · ") || "no numbers"}
                        {m.notes && ` · ${m.notes}`}
                      </span>
                      <DeleteMetricsButton id={m.id} />
                    </div>
                  ))}
                </div>
              ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
