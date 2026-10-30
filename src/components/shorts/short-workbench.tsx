"use client";

import { DownloadIcon, FilmIcon, RefreshCwIcon, SaveIcon, TriangleAlertIcon, WandSparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type CaptionCue, parseCaptionLines, validateCaptions, type VideoSettings } from "@/lib/shorts";
import { computeFraming } from "@/lib/short-video";
import { cn } from "@/lib/utils";
import { rebuildCaptions, renderShort, updateCaptions, updateVideoSettings } from "@/server/actions/shorts";

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
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(props.settings);
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
            <Toggle label="Show the hook text at the start" checked={settings.showHook} disabled={props.locked} onChange={(v) => set("showHook", v)} />
            <Toggle
              label="Normalise loudness to about -14 LUFS (YouTube's level)"
              checked={settings.normalizeAudio}
              disabled={props.locked}
              onChange={(v) => set("normalizeAudio", v)}
            />
          </div>
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
