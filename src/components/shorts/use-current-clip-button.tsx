"use client";

import { RefreshCwIcon } from "lucide-react";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { switchToCurrentSceneClip } from "@/server/actions/shorts";

export function UseCurrentClipButton({ shortId }: { shortId: string }) {
  const [pending, run] = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => switchToCurrentSceneClip(shortId))}>
      <RefreshCwIcon />
      Use the current clip
    </Button>
  );
}
