import { ArrowLeftIcon, CircleDashedIcon } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Module } from "@/lib/navigation";

export function ModulePlaceholder({ item }: { item: Module }) {
  return (
    <div className="grid gap-6">
      <PageHeader title={item.label} description={item.description} icon={item.icon} />

      <Card className="border-dashed">
        <CardHeader className="items-start">
          <div className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            <CircleDashedIcon className="size-3" />
            Not built yet
          </div>
          <CardTitle>This module is planned for a later milestone</CardTitle>
          <CardDescription>
            Nothing here is functional yet. The current milestone covers the dashboard, Idea
            Discovery, the Story Workshop, the Production Studio and the character library.
          </CardDescription>
        </CardHeader>
        {item.planned && (
          <CardContent className="grid gap-4">
            <div>
              <p className="mb-2 text-sm font-medium">Planned scope</p>
              <ul className="grid gap-2 text-sm text-muted-foreground">
                {item.planned.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60" />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/">
                  <ArrowLeftIcon />
                  Back to dashboard
                </Link>
              </Button>
              <Button asChild>
                <Link href="/ideas">Go to Idea Discovery</Link>
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
