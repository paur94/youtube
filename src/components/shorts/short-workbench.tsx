"use client";

import { DownloadIcon, FilmIcon, MusicIcon, RefreshCwIcon, SaveIcon, Trash2Icon, TriangleAlertIcon, UploadIcon, WandSparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { mediaUrl } from "@/lib/production";
import { audioSettings, type CaptionCue, MAX_CAPTION_MARGIN, MIN_CAPTION_MARGIN, MUSIC_TYPES, parseCaptionLines, validateCaptions, type VideoSettings } from "@/lib/shorts";
import { computeFraming, OUT_H, overlayMargins } from "@/lib/short-video";
import { cn } from "@/lib/utils";
import { rebuildCaptions, removeShortMusic, renderShort, updateCaptions, updateVideoSettings } from "@/server/actions/shorts";

import { VerticalPreview } from "./vertical-preview";

export type WorkbenchProps = {
  shortId: string;
  locked: boolean;
  sourceUrl: string | null;
  sourceLabel: string;
  renderUrl: string | null;
  renderCurrent: boolean;
  renderedLabel: string | null;
  renderError: string | null;
  settings: VideoSettings;
  captionsText: string;
  captionsReviewed: boolean;
  durationSeconds: number | null;
  hook: string;
  hookSeconds: number;
  ffmpegAvailable: boolean;
};

export function ShortWorkbench(props: WorkbenchProps) {
  const id = useId();
  const [settings, setSettings] = useState(props.settings);
  const [captionsText, setCaptionsText] = useState(props.captionsText);
  const [reviewed, setReviewed] = useState(props.captionsReviewed);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<"rendered" | "live">(props.renderUrl && props.renderCurrent ? "rendered" : "live");
  const [savingSettings, runSettings] = useAction();
  const [savingCaptions, runCaptions] = useAction();
  const [rendering, runRender] = useAction();

  const parsed = parseCaptionLines(captionsText);
  const cues: CaptionCue[] = parsed.cues;
  const captionIssues = validateCaptions(cues, props.durationSeconds);
  // The music file is saved by its own upload, so it never makes the settings dirty.
  const comparable = (s: VideoSettings) => JSON.stringify({ ...s, ...audioSettings(s), music: null });
  const settingsDirty = comparable(settings) !== comparable(props.settings);
  const audio = { ...audioSettings(settings), music: props.settings.music ?? null };
  const captionsDirty = captionsText !== props.captionsText || reviewed !== props.captionsReviewed;
  const framing = dims ? computeFraming(dims.w, dims.h, settings) : null;
  const set = <K extends keyof VideoSettings>(key: K, value: VideoSettings[K]) => setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="grid content-start gap-2">
          <p className="text-sm font-medium">
            Source clip <span className="font-normal text-muted-foreground">· {props.sourceLabel} · unchanged</span>
          </p>
          {props.sourceUrl ? (
            <video src={props.sourceUrl} controls playsInline preload="metadata" className="aspect-video w-full rounded-md border bg-black object-contain" />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-md border text-sm text-muted-foreground">
              Source file not available
            </div>
          )}
        </div>
        <div className="grid content-start gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Final 9:16</p>
            <div className="flex rounded-md border p-0.5 text-xs">
              {(["rendered", "live"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={v === "rendered" && !props.renderUrl}
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded px-2 py-0.5 disabled:opacity-40",
                    view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "rendered" ? "Rendered" : "Live preview"}
                </button>
              ))}
            </div>
          </div>
          {view === "rendered" && props.renderUrl ? (
            <>
              <video src={props.renderUrl} controls playsInline preload="metadata" className="aspect-9/16 w-full rounded-md border bg-black object-contain" />
              <p className={cn("text-xs", props.renderCurrent ? "text-muted-foreground" : "text-amber-400")}>
                {props.renderCurrent ? `Rendered ${props.renderedLabel}` : "Out of date: settings, captions or hook changed since this render."}
              </p>
            </>
          ) : props.sourceUrl ? (
            <>
              <VerticalPreview
                src={props.sourceUrl}
                settings={settings}
                captions={cues}
                hook={props.hook}
                hookSeconds={props.hookSeconds}
                onDimensions={(w, h) => setDims({ w, h })}
              />
              <p className="text-xs text-muted-foreground">Simulated in the browser. Render to check the real file.</p>
            </>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="grid content-start gap-3 rounded-lg border p-4">
          <div>
            <h3 className="font-medium">Framing and audio</h3>
            <p className="text-xs text-muted-foreground">
              Zoom 1× keeps the whole original picture on a blurred copy of itself. Zooming in crops the sides: check
              that no character or action leaves the frame.
            </p>
          </div>
          <Slider
            id={`${id}-zoom`}
            label="Zoom"
            value={settings.zoom}
            min={1}
            max={framing ? Math.round(framing.maxZoom * 100) / 100 : 3.2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            disabled={props.locked}
            onChange={(v) => set("zoom", v)}
          />
          <Slider
            id={`${id}-fx`}
            label="Horizontal focus"
            value={settings.focusX}
            min={0}
            max={100}
            step={1}
            format={(v) => (v < 45 ? "left" : v > 55 ? "right" : "centre") + ` (${v}%)`}
            disabled={props.locked || settings.zoom <= 1}
            onChange={(v) => set("focusX", v)}
          />
          <Slider
            id={`${id}-fy`}
            label="Vertical focus"
            value={settings.focusY}
            min={0}
            max={100}
            step={1}
            format={(v) => (v < 45 ? "top" : v > 55 ? "bottom" : "centre") + ` (${v}%)`}
            disabled={props.locked || !framing || framing.scaledH <= 1920}
            onChange={(v) => set("focusY", v)}
          />
          {framing && framing.croppedFraction > 0.005 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-400">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {Math.round(framing.croppedFraction * 100)}% of the original picture is cut off.
              {framing.scale > 1.5 && ` The source is enlarged ${framing.scale.toFixed(1)}×, so it will look softer.`}
            </p>
          )}
          <div className="grid gap-2 text-sm">
            <Toggle label="Burn captions into the video" checked={settings.burnCaptions} disabled={props.locked} onChange={(v) => set("burnCaptions", v)} />
            {settings.burnCaptions && (
              <div className="grid gap-1">
                <Slider
                  id={`${id}-cpos`}
                  label="Caption height"
                  value={framing ? overlayMargins(framing, settings.captionMargin).captionMargin : (settings.captionMargin ?? 420)}
                  min={MIN_CAPTION_MARGIN}
                  max={MAX_CAPTION_MARGIN}
                  step={10}
                  format={(v) => `${Math.round((v / OUT_H) * 100)}% from the bottom${settings.captionMargin === undefined ? " · auto" : ""}`}
                  disabled={props.locked}
                  onChange={(v) => set("captionMargin", v)}
                />
                {settings.captionMargin !== undefined && (
                  <button
                    type="button"
                    disabled={props.locked}
                    onClick={() => set("captionMargin", undefined)}
                    className="justify-self-start text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    Back to automatic
                  </button>
                )}
                {settings.captionMargin !== undefined && settings.captionMargin < 380 && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-400">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    YouTube&apos;s Shorts title and buttons may cover captions this low.
                  </p>
                )}
              </div>
            )}
            <Toggle label="Show the hook text at the start" checked={settings.showHook} disabled={props.locked} onChange={(v) => set("showHook", v)} />
            <Toggle
              label="Normalise loudness to about -14 LUFS (YouTube's level)"
              checked={settings.normalizeAudio}
              disabled={props.locked}
              onChange={(v) => set("normalizeAudio", v)}
            />
            <Toggle
              label="Mute the clip's own sound (removes voices too)"
              checked={audio.muteOriginal}
              disabled={props.locked}
              onChange={(v) => set("muteOriginal", v)}
            />
          </div>
          <MusicPicker shortId={props.shortId} music={audio.music} locked={props.locked} settingsDirty={settingsDirty} />
          <Slider
            id={`${id}-music-volume`}
            label="Music volume"
            value={Math.round(audio.musicVolume * 100)}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            disabled={props.locked || !audio.music}
            onChange={(v) => set("musicVolume", v / 100)}
          />
          <div className="grid gap-2 text-sm">
            <Toggle
              label="Lower the music while characters speak"
              checked={audio.duckMusic}
              disabled={props.locked || !audio.music || audio.muteOriginal}
              onChange={(v) => set("duckMusic", v)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Music already mixed into the clip can&apos;t be taken out on its own: muting drops it together with the
            voices. The new track loops or is cut to the clip&apos;s length and fades in and out. Render to hear the mix.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={props.locked || !settingsDirty || savingSettings}
              onClick={() => runSettings(() => updateVideoSettings(props.shortId, settings))}
            >
              <SaveIcon />
              {savingSettings ? "Saving…" : "Save settings"}
            </Button>
            <Button
              disabled={props.locked || rendering || settingsDirty || captionsDirty || !props.ffmpegAvailable || !props.sourceUrl}
              title={
                !props.ffmpegAvailable
                  ? "Install FFmpeg first (see README)"
                  : settingsDirty || captionsDirty
                    ? "Save your changes first"
                    : undefined
              }
              onClick={() => runRender(() => renderShort(props.shortId), () => setView("rendered"))}
            >
              <FilmIcon />
              {rendering ? "Rendering…" : props.renderUrl ? "Render again" : "Render 9:16"}
            </Button>
          </div>
          {!props.ffmpegAvailable && (
            <p className="text-xs text-amber-400">FFmpeg wasn&apos;t found, so rendering and measurements are disabled. See the README.</p>
          )}
          {props.renderError && <p className="text-xs text-destructive">Last render failed: {props.renderError}</p>}
        </section>

        <section className="grid content-start gap-3 rounded-lg border p-4">
          <div>
            <h3 className="font-medium">Captions</h3>
            <p className="text-xs text-muted-foreground">
              One per line: <code className="rounded bg-muted px-1">start-end | text</code> in seconds. The first draft is
              timed from word counts, not from the audio: play the preview and adjust.
            </p>
          </div>
          <Label htmlFor={`${id}-captions`} className="sr-only">
            Captions
          </Label>
          <Textarea
            id={`${id}-captions`}
            rows={8}
            value={captionsText}
            disabled={props.locked}
            onChange={(e) => {
              setCaptionsText(e.target.value);
              setReviewed(false);
            }}
            className="font-mono text-xs"
          />
          {[...parsed.errors, ...captionIssues.map((i) => i.message)].slice(0, 4).map((message) => (
            <p key={message} className="text-xs text-amber-400">
              {message}
            </p>
          ))}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={props.locked}
              onChange={(e) => setReviewed(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-primary"
            />
            Captions match the audio (I played it through)
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href={`/api/shorts/${props.shortId}/captions`}>
                <DownloadIcon />
                .srt
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={props.locked || savingCaptions}
              onClick={() => runCaptions(() => rebuildCaptions(props.shortId))}
            >
              <RefreshCwIcon />
              Rebuild from dialogue
            </Button>
            <Button
              size="sm"
              disabled={props.locked || !captionsDirty || savingCaptions || parsed.errors.length > 0}
              onClick={() => runCaptions(() => updateCaptions(props.shortId, captionsText, reviewed))}
            >
              <WandSparklesIcon />
              {savingCaptions ? "Saving…" : "Save captions"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={cn("grid gap-1", disabled && "opacity-50")}>
      <div className="flex justify-between text-sm">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-primary"
      />
    </div>
  );
}

const MUSIC_ACCEPT = [...Object.keys(MUSIC_TYPES), ...new Set(Object.values(MUSIC_TYPES).map((e) => `.${e}`))].join(",");

/**
 * Uploads straight away (through a route handler: server actions cap bodies at 1 MB). Waits for the
 * other settings to be saved: the saved Short remounts the workbench, which would drop unsaved edits.
 */
function MusicPicker({
  shortId,
  music,
  locked,
  settingsDirty,
}: {
  shortId: string;
  music: VideoSettings["music"];
  locked: boolean;
  settingsDirty: boolean;
}) {
  const saveFirst = settingsDirty ? "Save your changes first" : undefined;
  const id = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  // Remounts the file input to clear it after an upload.
  const [inputKey, setInputKey] = useState(0);
  const [uploading, startUpload] = useTransition();
  const [removing, runRemove] = useAction();

  function upload() {
    if (!file) return;
    startUpload(async () => {
      try {
        const form = new FormData();
        form.set("music", file);
        const response = await fetch(`/api/shorts/${shortId}/music`, { method: "POST", body: form });
        const result: { ok: boolean; message: string } = await response
          .json()
          .catch(() => ({ ok: false, message: `Upload failed (HTTP ${response.status})` }));
        if (result.ok) {
          toast.success(result.message);
          setFile(null);
          setInputKey((k) => k + 1);
          router.refresh();
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("Upload failed. Check that the dev server is running and try again.");
      }
    });
  }

  if (music) {
    return (
      <div className="grid gap-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5">
            <MusicIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{music.name}</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={locked || removing || settingsDirty}
            title={saveFirst}
            onClick={() => runRemove(() => removeShortMusic(shortId))}
          >
            <Trash2Icon />
            Remove
          </Button>
        </div>
        <audio src={mediaUrl(music.filePath)} controls preload="none" className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-music`}>Background music (MP3, WAV, M4A, AAC or OGG)</Label>
      <div className="flex gap-2">
        <Input
          key={inputKey}
          id={`${id}-music`}
          type="file"
          accept={MUSIC_ACCEPT}
          disabled={locked || uploading}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button variant="outline" disabled={locked || uploading || !file || settingsDirty} title={saveFirst} onClick={upload}>
          <UploadIcon />
          {uploading ? "Uploading…" : "Add"}
        </Button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 accent-primary"
      />
      {label}
    </label>
  );
}
