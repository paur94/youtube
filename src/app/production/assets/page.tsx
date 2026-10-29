import { ArrowLeftIcon, ImagesIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/page-header";
import { AssetCard } from "@/components/production/asset-card";
import { toAssetItem } from "@/components/production/format";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ASSET_KINDS, ASSET_STATUS_LABELS, ASSET_STATUSES } from "@/lib/production";
import { cn } from "@/lib/utils";
import { getPlanOptions, listAssets } from "@/server/queries/production";

export const metadata: Metadata = { title: "Asset library" };

const filtersSchema = z.object({
  status: z.enum(ASSET_STATUSES).optional().catch(undefined),
  kind: z.enum(ASSET_KINDS).optional().catch(undefined),
  plan: z.uuid().optional().catch(undefined),
});

type Filters = z.infer<typeof filtersSchema>;

export default function AssetLibraryPage({ searchParams }: PageProps<"/production/assets">) {
  return (
    <div className="grid gap-6">
      <Link
        href="/production"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        Production Studio
      </Link>
      <PageHeader
        title="Asset library"
        description="Every generated and imported image and clip, with its review status. Originals are never deleted."
        icon={ImagesIcon}
      />
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <AssetsData searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function filterHref(filters: Filters, change: Partial<Filters>) {
  const next = { ...filters, ...change };
  const params = new URLSearchParams();
  if (next.status) params.set("status", next.status);
  if (next.kind) params.set("kind", next.kind);
  if (next.plan) params.set("plan", next.plan);
  const query = params.toString();
  return query ? `/production/assets?${query}` : "/production/assets";
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:border-primary/40",
        active ? "border-primary/60 bg-primary/10 text-foreground" : "text-muted-foreground",
      )}
    >
      {children}
    </Link>
  );
}

async function AssetsData({ searchParams }: Pick<PageProps<"/production/assets">, "searchParams">) {
  await connection();
  const raw = await searchParams;
  const filters = filtersSchema.parse({
    status: typeof raw.status === "string" ? raw.status : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
    plan: typeof raw.plan === "string" ? raw.plan : undefined,
  });
  const [rows, plans] = await Promise.all([
    listAssets({ status: filters.status, kind: filters.kind, planId: filters.plan }),
    getPlanOptions(),
  ]);
  const revisions = new Map(rows.map((r) => [r.asset.id, r.asset.revision]));

  return (
    <>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-14 text-xs text-muted-foreground">Status</span>
          <Chip href={filterHref(filters, { status: undefined })} active={!filters.status}>
            All
          </Chip>
          {ASSET_STATUSES.map((s) => (
            <Chip key={s} href={filterHref(filters, { status: s })} active={filters.status === s}>
              {ASSET_STATUS_LABELS[s]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-14 text-xs text-muted-foreground">Type</span>
          <Chip href={filterHref(filters, { kind: undefined })} active={!filters.kind}>
            All
          </Chip>
          <Chip href={filterHref(filters, { kind: "image" })} active={filters.kind === "image"}>
            Images
          </Chip>
          <Chip href={filterHref(filters, { kind: "video" })} active={filters.kind === "video"}>
            Clips
          </Chip>
        </div>
        {plans.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 text-xs text-muted-foreground">Plan</span>
            <Chip href={filterHref(filters, { plan: undefined })} active={!filters.plan}>
              All
            </Chip>
            {plans.map((p) => (
              <Chip key={p.id} href={filterHref(filters, { plan: p.id })} active={filters.plan === p.id}>
                {p.title}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <ImagesIcon className="size-5" />
            {filters.status || filters.kind || filters.plan
              ? "No assets match these filters."
              : "No assets yet. Generate or import them from a scene in a production plan."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((row) => (
            <div key={row.asset.id} className="grid content-start gap-1">
              <Link
                href={`/production/${row.planId}/scenes/${row.sceneId}`}
                className="truncate text-xs text-muted-foreground hover:text-foreground"
              >
                {row.planTitle} · Scene {row.scenePosition + 1}: {row.sceneTitle}
              </Link>
              <AssetCard asset={toAssetItem(row.asset, (id) => revisions.get(id))} isFinal={row.isSelected} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
