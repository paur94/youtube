"use client";

import { UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MEDIA_TYPES } from "@/lib/production";
import { importAssetFromUrl } from "@/server/actions/production";

const ACCEPT = Object.keys(MEDIA_TYPES).join(",");

/** Reads a local video's length in the browser so imported clips record their duration. */
function readVideoDuration(file: File) {
  return new Promise<number | null>((resolve) => {
    if (!file.type.startsWith("video/")) return resolve(null);
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => done(Number.isFinite(video.duration) ? Math.round(video.duration * 100) / 100 : null);
    video.onerror = () => done(null);
    video.src = url;
  });
}

type Target = { sceneId: string; characterId?: never } | { characterId: string; sceneId?: never };

export function ImportAssetDialog({
  target,
  jobId,
  replacesId,
  label = "Import result",
  title = "Import a generated asset",
  description,
  variant = "outline",
}: {
  target: Target;
  /** Open manual job this file completes. */
  jobId?: string | null;
  replacesId?: string | null;
  label?: string;
  title?: string;
  description?: string;
  variant?: "outline" | "default" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"file" | "url">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const id = useId();
  const forScene = Boolean(target.sceneId);

  function reset() {
    setFile(null);
    setUrl("");
    setModel("");
  }

  function submit() {
    startTransition(async () => {
      try {
        let result: { ok: boolean; message: string };
        if (mode === "url" && target.sceneId) {
          result = await importAssetFromUrl({ sceneId: target.sceneId, url, jobId, replacesId, model: model || null });
        } else {
          if (!file) return;
          const form = new FormData();
          form.set("file", file);
          if (target.sceneId) form.set("sceneId", target.sceneId);
          if (target.characterId) form.set("characterId", target.characterId);
          if (jobId) form.set("jobId", jobId);
          if (replacesId) form.set("replacesId", replacesId);
          if (model) form.set("model", model);
          const duration = await readVideoDuration(file);
          if (duration) form.set("durationSeconds", String(duration));
          const response = await fetch("/api/assets", { method: "POST", body: form });
          result = await response.json().catch(() => ({ ok: false, message: `Upload failed (HTTP ${response.status})` }));
        }
        if (result.ok) {
          toast.success(result.message);
          setOpen(false);
          reset();
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("Upload failed. Check that the dev server is running and try again.");
      }
    });
  }

  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        <UploadIcon />
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {description ??
                "Upload the file you downloaded from Higgsfield, or paste a direct https link to it. The original is copied into the local media folder and marked “Needs review”."}
            </DialogDescription>
          </DialogHeader>

          {forScene && (
            <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm" role="tablist">
              {(["file", "url"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className="flex-1 rounded-md px-2 py-1 aria-selected:bg-background aria-selected:shadow-sm"
                >
                  {m === "file" ? "Upload file" : "From URL"}
                </button>
              ))}
            </div>
          )}

          {mode === "file" || !forScene ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-file`}>File</Label>
              <Input
                id={`${id}-file`}
                type="file"
                accept={forScene ? ACCEPT : "image/png,image/jpeg,image/webp"}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {forScene ? "PNG, JPEG, WebP, GIF up to 30 MB · MP4, WebM, MOV up to 500 MB" : "PNG, JPEG or WebP up to 30 MB"}
              </p>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-url`}>File URL</Label>
              <Input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                placeholder="https://…/clip.mp4"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Must link directly to the image or video file.</p>
            </div>
          )}

          {forScene && (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-model`}>
                Model used <span className="font-normal text-muted-foreground">· Optional</span>
              </Label>
              <Input
                id={`${id}-model`}
                maxLength={120}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. Kling 2.5 Turbo in the Higgsfield app"
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || (mode === "file" || !forScene ? !file : !url.trim())} onClick={submit}>
              {pending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
