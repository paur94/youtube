import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { SampleDataButton } from "@/components/ideas/sample-data-button";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SAMPLE_IDEAS } from "@/lib/sample-ideas";
import { MODULES } from "@/lib/navigation";
import { getClaudeConfig } from "@/server/ai/claude";
import { getMediaRoot } from "@/server/media/storage";
import { getHedraConfig } from "@/server/providers/hedra";
import { getHiggsfieldConfig } from "@/server/providers/higgsfield";
import { getSampleIdeaCount } from "@/server/queries/ideas";

export const metadata: Metadata = { title: MODULES.settings.label };

export default function SettingsPage() {
  return (
    <div className="grid gap-6">
      <PageHeader
        title={MODULES.settings.label}
        description={MODULES.settings.description}
        icon={MODULES.settings.icon}
      />

      <div className="grid gap-6 lg:grid-cols-2">
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
              <Row label="YouTube account" value="Not connected (planned)" />
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
    </>
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
