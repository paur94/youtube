"use client";

import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = error instanceof Error && "digest" in error ? String(error.digest) : undefined;

  return (
    <Card className="mx-auto mt-10 max-w-lg">
      <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <TriangleAlertIcon className="size-5 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          This page could not be loaded. The most common cause is that the database isn&apos;t
          running. Start it with <code className="rounded bg-muted px-1">npm run db:up</code>, then
          try again.
        </p>
        {digest && <p className="text-xs text-muted-foreground">Error reference: {digest}</p>}
        <div className="flex gap-2">
          <Button onClick={() => retry()}>
            <RotateCcwIcon />
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Dashboard</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
