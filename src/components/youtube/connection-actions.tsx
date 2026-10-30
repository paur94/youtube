"use client";

import { LinkIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";

import { useAction } from "@/components/production/use-action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { disconnectYouTube } from "@/server/actions/youtube";

/** A plain link: the route handler builds the consent URL server-side and redirects to Google. */
export function ConnectYouTubeButton({ reconnect }: { reconnect?: boolean }) {
  return (
    <Button asChild size="sm" variant={reconnect ? "outline" : "default"}>
      <a href="/api/youtube/connect">
        <LinkIcon />
        {reconnect ? "Switch channel" : "Connect YouTube channel"}
      </a>
    </Button>
  );
}

export function DisconnectYouTubeButton({ channelTitle }: { channelTitle: string }) {
  const [pending, run] = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(true)}>
        <UnlinkIcon />
        Disconnect
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect “{channelTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Revokes this app&apos;s access at Google and deletes the stored tokens. Videos already on YouTube stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run(() => disconnectYouTube())}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
