"use client";

import { CalendarClockIcon, CalendarXIcon, CircleCheckBigIcon, DownloadIcon, FileJsonIcon, Undo2Icon } from "lucide-react";
import { useId, useState } from "react";

import { CopyButton } from "@/components/production/copy-button";
import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ShortStatus } from "@/lib/shorts";
import { markPublished, scheduleShort, unmarkPublished, unscheduleShort } from "@/server/actions/shorts";

/** `datetime-local` value in the browser's time zone. */
function toLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function QueueActions({
  shortId,
  status,
  scheduledAt,
}: {
  shortId: string;
  status: ShortStatus;
  scheduledAt: string | null;
}) {
  const [pending, run] = useAction();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [url, setUrl] = useState("");
  const id = useId();

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {(status === "approved" || status === "scheduled") && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              const base = scheduledAt ? new Date(scheduledAt) : new Date(Date.now() + 24 * 3600_000);
              setWhen(toLocalInput(base));
              setScheduleOpen(true);
            }}
          >
            <CalendarClockIcon />
            {status === "scheduled" ? "Reschedule" : "Schedule"}
          </Button>
          {status === "scheduled" && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unscheduleShort(shortId))}>
              <CalendarXIcon />
              Unschedule
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPublishOpen(true)}>
            <CircleCheckBigIcon />
            Mark published
          </Button>
        </>
      )}
      {status === "published" && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unmarkPublished(shortId))}>
          <Undo2Icon />
          Not published
        </Button>
      )}

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule</DialogTitle>
            <DialogDescription>
              Records when you plan to publish. Nothing is uploaded: set the same time in YouTube Studio when you upload the file.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-when`}>Publish at (your local time)</Label>
            <Input id={`${id}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !when}
              onClick={() => run(() => scheduleShort(shortId, new Date(when).toISOString()), () => setScheduleOpen(false))}
            >
              Save schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as published</DialogTitle>
            <DialogDescription>Only do this after the Short is live on YouTube. It locks the Short and enables analytics entry.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-url`}>YouTube link (optional)</Label>
            <Input id={`${id}-url`} placeholder="https://youtube.com/shorts/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending} onClick={() => run(() => markPublished(shortId, url), () => setPublishOpen(false))}>
              Mark published
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function YouTubeMetadataButton({
  title,
  description,
  tags,
  json,
  checklist,
  videoUrl,
  captionsUrl,
}: {
  title: string;
  description: string;
  tags: string;
  json: string;
  checklist: string[];
  videoUrl: string | null;
  captionsUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileJsonIcon />
        YouTube metadata
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload package</DialogTitle>
            <DialogDescription>Copy these into YouTube Studio. Nothing is sent to YouTube by this app.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 text-sm">
            <CopyRow label="Title" text={title} />
            <CopyRow label="Description (hashtags included)" text={description} multiline />
            <CopyRow label="Tags" text={tags} />
            <div className="grid gap-1">
              <p className="font-medium">Settings checklist</p>
              <ul className="grid gap-1 text-muted-foreground">
                {checklist.map((c) => (
                  <li key={c}>· {c}</li>
                ))}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              {videoUrl && (
                <Button asChild size="sm" variant="outline">
                  <a href={videoUrl} download>
                    <DownloadIcon />
                    Vertical video (.mp4)
                  </a>
                </Button>
              )}
              {captionsUrl && (
                <Button asChild size="sm" variant="outline">
                  <a href={captionsUrl}>
                    <DownloadIcon />
                    Captions (.srt)
                  </a>
                </Button>
              )}
            </div>
            <CopyRow label="YouTube Data API body (videos.insert, for a future integration)" text={json} multiline mono />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CopyRow({ label, text, multiline, mono }: { label: string; text: string; multiline?: boolean; mono?: boolean }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{label}</p>
        <CopyButton text={text} />
      </div>
      <pre
        className={`max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap ${mono ? "font-mono" : "font-sans"} ${multiline ? "" : "truncate"}`}
      >
        {text || "—"}
      </pre>
    </div>
  );
}
