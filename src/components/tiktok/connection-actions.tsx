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
import { disconnectTikTok } from "@/server/actions/tiktok";

/** A plain link: the route handler builds the authorization URL server-side and redirects to TikTok. */
export function ConnectTikTokButton({ reconnect }: { reconnect?: boolean }) {
  return (
    <Button asChild size="sm" variant={reconnect ? "outline" : "default"}>
      <a href="/api/tiktok/connect">
        <LinkIcon />
        {reconnect ? "Switch account" : "Connect TikTok account"}
      </a>
    </Button>
  );
}

export function DisconnectTikTokButton({ displayName }: { displayName: string }) {
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
            <AlertDialogTitle>Disconnect “{displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Revokes this app&apos;s access at TikTok and deletes the stored tokens. Posts already on TikTok stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => run(() => disconnectTikTok())}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
