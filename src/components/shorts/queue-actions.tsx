"use client";

import {
  CalendarClockIcon,
  CalendarXIcon,
  CircleCheckBigIcon,
  DownloadIcon,
  FileJsonIcon,
  RefreshCwIcon,
  Undo2Icon,
  UploadIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { CopyButton } from "@/components/production/copy-button";
import { dateTimeFormat } from "@/components/production/format";
import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isPublishable, type ShortStatus } from "@/lib/shorts";
import {
  markPublished,
  publishShortToYouTube,
  refreshYouTubeStatus,
  scheduleShort,
  unmarkPublished,
  unscheduleShort,
} from "@/server/actions/shorts";

/** `datetime-local` value in the browser's time zone. */
function toLocalInput(date: Date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function QueueActions({
  shortId,
  title,
  status,
  scheduledAt,
  uploaded,
  channelTitle,
}: {
  shortId: string;
  title: string;
  status: ShortStatus;
  scheduledAt: string | null;
  /** Uploaded to YouTube by this app. */
  uploaded: boolean;
  /** The connected channel, or null when none is connected. */
  channelTitle: string | null;
}) {
  const [pending, run] = useAction();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [canSchedule, setCanSchedule] = useState(false);
  const [approved, setApproved] = useState(false);
  const [when, setWhen] = useState("");
  const [url, setUrl] = useState("");
  const id = useId();
  const publishable = isPublishable(status) && !uploaded;

  function openUpload() {
    // YouTube needs some lead time for a scheduled publish; the server checks this again.
    const future = scheduledAt !== null && new Date(scheduledAt).getTime() > Date.now() + 5 * 60_000;
    setCanSchedule(future);
    setMode(future ? "schedule" : "now");
    setApproved(false);
    setUploadOpen(true);
  }

  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {publishable && (
        <>
          {channelTitle && (
            <Button size="sm" disabled={pending} onClick={openUpload}>
              <UploadIcon />
              {status === "failed" ? "Retry upload" : "Upload to YouTube"}
            </Button>
          )}
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
            {scheduledAt ? "Reschedule" : "Schedule"}
          </Button>
          {scheduledAt && (
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
      {uploaded && status !== "published" && (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => refreshYouTubeStatus(shortId))}>
          <RefreshCwIcon />
          Check YouTube
        </Button>
      )}
      {(status === "published" || uploaded) && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unmarkPublished(shortId))}>
          <Undo2Icon />
          {status === "published" ? "Not published" : "Forget upload"}
        </Button>
      )}

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload to YouTube</DialogTitle>
            <DialogDescription>
              Uploads “{title}” to {channelTitle} with its approved metadata. Nothing is sent to YouTube until you confirm here.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="grid gap-3">
            <legend className="sr-only">When it goes public</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-mode`}
                checked={mode === "now"}
                onChange={() => setMode("now")}
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
              />
              <span>
                <span className="font-medium">Publish now</span>
                <span className="block text-muted-foreground">Public as soon as YouTube finishes processing.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2 text-sm ${canSchedule ? "" : "opacity-50"}`}>
              <input
                type="radio"
                name={`${id}-mode`}
                checked={mode === "schedule"}
                disabled={!canSchedule}
                onChange={() => setMode("schedule")}
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
              />
              <span>
                <span className="font-medium">Upload now, publish at the scheduled time</span>
                <span className="block text-muted-foreground">
                  {canSchedule && scheduledAt
                    ? `Private until ${dateTimeFormat.format(new Date(scheduledAt))}, then YouTube makes it public.`
                    : "Use Schedule to set a time at least 5 minutes ahead first."}
                </span>
              </span>
            </label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary"
            />
            {mode === "now"
              ? `I approve publishing this Short publicly on ${channelTitle} now.`
              : `I approve uploading this Short to ${channelTitle} to go public at the scheduled time.`}
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !approved}
              onClick={() => run(() => publishShortToYouTube(shortId, mode, approved), () => setUploadOpen(false))}
            >
              <UploadIcon />
              {pending ? "Uploading…" : mode === "now" ? "Publish" : "Upload and schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule</DialogTitle>
            <DialogDescription>
              Records when this Short should go live. Nothing is uploaded until you choose “Upload to YouTube” (or upload it in
              YouTube Studio yourself).
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
            <DialogDescription>
              For Shorts you uploaded in YouTube Studio. Only do this after it is live: it locks the Short and enables analytics entry.
            </DialogDescription>
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
            <DialogDescription>For uploading in YouTube Studio by hand. Opening this sends nothing to YouTube.</DialogDescription>
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
            <CopyRow label="YouTube Data API body (videos.insert)" text={json} multiline mono />
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
