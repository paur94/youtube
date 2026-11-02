"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  CaptionsIcon,
  FilmIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  ScissorsIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  clipLength,
  computeTimeline,
  type EditSettings,
  formatTimestamp,
  MIN_CLIP_SECONDS,
  type Transition,
  TRANSITION_LABELS,
  TRANSITIONS,
  type VideoClip,
} from "@/lib/long-video";
import { mediaUrl } from "@/lib/production";
import { formatCaptionLines, parseCaptionLines, validateCaptions } from "@/lib/shorts";
import { cn } from "@/lib/utils";
import { cancelVideoRender, renderVideo, saveVideoEdit, switchToCurrentSceneClips } from "@/server/actions/videos";

type EditorClip = {
  assetId: string;
  sceneNumber: number;
  title: string;
  filePath: string;
  sourceSeconds: number;
  trimStart: number;
  trimEnd: number | null;
  /** Null for a clip just added: its captions are generated from the dialogue on save. */
  captionsText: string | null;
  note: string | null;
};

export type VideoEditorProps = {
  videoId: string;
  locked: boolean;
  clips: VideoClip[];
  available: { assetId: string; position: number; title: string; filePath: string; durationSeconds: string | null }[];
  settings: EditSettings;
  captionsReviewed: boolean;
  replacedCount: number;
  ffmpegAvailable: boolean;
  render: {
    url: string | null;
    current: boolean;
    label: string | null;
    error: string | null;
    running: boolean;
    progress: number | null;
  };
};

function toEditor(clip: VideoClip): EditorClip {
  const notes = [
    clip.width && clip.height ? `${clip.width}×${clip.height}` : null,
    clip.hasAudio ? null : "no sound",
  ].filter(Boolean);
  return {
    assetId: clip.assetId,
    sceneNumber: clip.sceneNumber,
    title: clip.title,
    filePath: clip.filePath,
    sourceSeconds: clip.sourceSeconds,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    captionsText: formatCaptionLines(clip.captions),
    note: notes.join(" · ") || null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function VideoEditor(props: VideoEditorProps) {
  const id = useId();
  const router = useRouter();
  const [items, setItems] = useState<EditorClip[]>(() => props.clips.map(toEditor));
  const [settings, setSettings] = useState(props.settings);
  const [reviewed, setReviewed] = useState(props.captionsReviewed);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, runSave] = useAction();
  const [starting, runRender] = useAction();
  const [swapping, runSwap] = useAction();

  // While FFmpeg works in the background, refresh the page for progress.
  useEffect(() => {
    if (!props.render.running) return;
    const timer = setInterval(() => router.refresh(), 2500);
    return () => clearInterval(timer);
  }, [props.render.running, router]);

  const payload = {
    clips: items.map((c) => ({ assetId: c.assetId, trimStart: c.trimStart, trimEnd: c.trimEnd, captions: c.captionsText })),
    settings,
    captionsReviewed: reviewed,
  };
  const initial = {
    clips: props.clips.map((c) => ({ assetId: c.assetId, trimStart: c.trimStart, trimEnd: c.trimEnd, captions: formatCaptionLines(c.captions) })),
    settings: props.settings,
    captionsReviewed: props.captionsReviewed,
  };
  const dirty = JSON.stringify(payload) !== JSON.stringify(initial);
  const timeline = computeTimeline(items, settings);
  const captionErrors = items.flatMap((c) =>
    c.captionsText === null ? [] : parseCaptionLines(c.captionsText).errors.map((e) => `Scene ${c.sceneNumber}: ${e}`),
  );
  const trimErrors = items.filter((c) => clipLength(c) < MIN_CLIP_SECONDS).map((c) => `Scene ${c.sceneNumber} is shorter than ${MIN_CLIP_SECONDS}s`);
  const onTimeline = new Set(items.map((c) => c.assetId));
  const addable = props.available.filter((s) => !onTimeline.has(s.assetId));
  const disabled = props.locked || props.render.running;
  const set = <K extends keyof EditSettings>(key: K, value: EditSettings[K]) => setSettings((s) => ({ ...s, [key]: value }));
  const update = (assetId: string, patch: Partial<EditorClip>) => setItems((list) => list.map((c) => (c.assetId === assetId ? { ...c, ...patch } : c)));

  function move(index: number, by: -1 | 1) {
    setItems((list) => {
      const next = [...list];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });
  }

  function add(scene: VideoEditorProps["available"][number]) {
    setItems((list) => [
      ...list,
      {
        assetId: scene.assetId,
        sceneNumber: scene.position + 1,
        title: scene.title,
        filePath: scene.filePath,
        sourceSeconds: scene.durationSeconds ? Number(scene.durationSeconds) : 0,
        trimStart: 0,
        trimEnd: null,
        captionsText: null,
        note: "added: measured on save",
      },
    ]);
  }

  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">
            Final 16:9 <span className="font-normal text-muted-foreground">· 1920×1080{props.render.label ? ` · rendered ${props.render.label}` : ""}</span>
          </p>
          {props.render.url && !props.render.current && !props.render.running && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-400">
              <TriangleAlertIcon className="size-3.5" />
              Out of date: render again
            </span>
          )}
        </div>
        {props.render.running ? (
          <div className="grid aspect-video place-content-center gap-3 rounded-lg border bg-muted/30 p-6 text-center">
            <p className="text-sm font-medium">Rendering… {Math.round((props.render.progress ?? 0) * 100)}%</p>
            <div className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((props.render.progress ?? 0) * 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">FFmpeg runs in the background. You can leave this page.</p>
            <Button variant="outline" size="sm" className="mx-auto" onClick={() => runRender(() => cancelVideoRender(props.videoId))}>
              <BanIcon />
              Cancel render
            </Button>
          </div>
        ) : props.render.url ? (
          <video key={props.render.url} src={props.render.url} controls preload="metadata" className="aspect-video w-full rounded-lg border bg-black" />
        ) : (
          <div className="grid aspect-video place-content-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Not rendered yet
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {items.length} clip{items.length === 1 ? "" : "s"} · <span className="tabular-nums">{formatTimestamp(timeline.total)}</span>
            {timeline.overlap > 0 && ` · ${timeline.overlap}s transitions`}
          </p>
          <Button
            disabled={disabled || dirty || starting || !props.ffmpegAvailable || items.length === 0 || trimErrors.length > 0}
            title={dirty ? "Save the edit first" : undefined}
            onClick={() => runRender(() => renderVideo(props.videoId), () => router.refresh())}
          >
            <FilmIcon />
            {starting ? "Starting…" : props.render.url ? "Render again" : "Render 16:9"}
          </Button>
        </div>
        {!props.ffmpegAvailable && <p className="text-xs text-amber-400">FFmpeg wasn&apos;t found, so rendering is disabled. See the README.</p>}
        {props.render.error && !props.render.running && <p className="text-xs text-destructive">Last render failed: {props.render.error}</p>}
      </section>

      {props.replacedCount > 0 && !props.locked && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="flex items-start gap-2">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
            {props.replacedCount} scene{props.replacedCount === 1 ? " has" : "s have"} a newer final clip in the Production Studio.
          </p>
          <Button size="sm" variant="outline" disabled={swapping || disabled} onClick={() => runSwap(() => switchToCurrentSceneClips(props.videoId))}>
            <RefreshCwIcon />
            Use the current clips
          </Button>
        </div>
      )}

      <section className="grid gap-3">
        <div>
          <h3 className="font-medium">Timeline</h3>
          <p className="text-xs text-muted-foreground">
            Reorder, trim or remove scenes. The original clips are never changed: every render is a new file.
          </p>
        </div>
        <ol className="grid gap-2">
          {items.map((clip, i) => {
            const open = expanded === clip.assetId;
            const parsed = clip.captionsText === null ? null : parseCaptionLines(clip.captionsText);
            const issues = parsed ? validateCaptions(parsed.cues, clip.sourceSeconds || null) : [];
            return (
              <li key={clip.assetId} className="rounded-lg border">
                <div className="flex flex-wrap items-center gap-2 p-2">
                  <div className="flex flex-col">
                    <Button variant="ghost" size="icon" className="size-6" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={disabled || i === items.length - 1}
                      onClick={() => move(i, 1)}
                      aria-label="Move down"
                    >
                      <ArrowDownIcon />
                    </Button>
                  </div>
                  <video src={`${mediaUrl(clip.filePath)}#t=${clip.trimStart + 0.5}`} muted preload="metadata" className="aspect-video h-12 shrink-0 rounded border bg-black object-contain" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      <span className="text-muted-foreground tabular-nums">{i + 1}.</span> {clip.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Scene {clip.sceneNumber} · {round1(clip.trimStart)}s–{round1(clip.trimEnd ?? clip.sourceSeconds)}s of {round1(clip.sourceSeconds)}s · plays{" "}
                      {round1(clipLength(clip))}s at {formatTimestamp(timeline.segments[i]?.start ?? 0)}
                      {clip.note && ` · ${clip.note}`}
                    </p>
                  </div>
                  <Button variant={open ? "secondary" : "outline"} size="sm" onClick={() => setExpanded(open ? null : clip.assetId)}>
                    <ScissorsIcon />
                    Trim & captions
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={disabled || items.length === 1}
                    onClick={() => setItems((list) => list.filter((c) => c.assetId !== clip.assetId))}
                    aria-label={`Remove scene ${clip.sceneNumber} from the timeline`}
                    title="Remove from the timeline"
                  >
                    <XIcon />
                  </Button>
                </div>
                {open && (
                  <ClipDetail
                    id={`${id}-${clip.assetId}`}
                    clip={clip}
                    disabled={disabled}
                    errors={[...(parsed?.errors ?? []), ...issues.map((x) => x.message)]}
                    onChange={(patch) => {
                      update(clip.assetId, patch);
                      if ("captionsText" in patch) setReviewed(false);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ol>
        {addable.length > 0 && !disabled && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Add back:</span>
            {addable.map((scene) => (
              <Button key={scene.assetId} variant="outline" size="sm" onClick={() => add(scene)}>
                <PlusIcon />
                Scene {scene.position + 1}: {scene.title}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 rounded-lg border p-4 text-sm">
        <h3 className="font-medium">Edit settings</h3>
        <div className="grid gap-2">
          <Label>Between scenes</Label>
          <div className="flex flex-wrap gap-1.5">
            {TRANSITIONS.map((t: Transition) => (
              <Button key={t} size="sm" variant={settings.transition === t ? "default" : "outline"} disabled={disabled} onClick={() => set("transition", t)}>
                {TRANSITION_LABELS[t]}
              </Button>
            ))}
          </div>
          {settings.transition !== "cut" && (
            <div className="grid max-w-sm gap-1">
              <div className="flex justify-between">
                <Label htmlFor={`${id}-tlen`}>Transition length</Label>
                <span className="text-xs text-muted-foreground tabular-nums">{settings.transitionSeconds.toFixed(1)}s</span>
              </div>
              <input
                id={`${id}-tlen`}
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={settings.transitionSeconds}
                disabled={disabled}
                onChange={(e) => set("transitionSeconds", Number(e.target.value))}
                className="accent-primary"
              />
            </div>
          )}
        </div>
        <div className="grid gap-2">
          <Label>Clips that aren&apos;t 16:9</Label>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant={settings.background === "blur" ? "default" : "outline"} disabled={disabled} onClick={() => set("background", "blur")}>
              Blurred sides
            </Button>
            <Button size="sm" variant={settings.background === "black" ? "default" : "outline"} disabled={disabled} onClick={() => set("background", "black")}>
              Black bars
            </Button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle label="Fade in from and out to black" checked={settings.fadeInOut} disabled={disabled} onChange={(v) => set("fadeInOut", v)} />
          <Toggle label="Normalise loudness (-14 LUFS)" checked={settings.normalizeAudio} disabled={disabled} onChange={(v) => set("normalizeAudio", v)} />
          <Toggle label="Burn captions into the picture" checked={settings.burnCaptions} disabled={disabled} onChange={(v) => set("burnCaptions", v)} />
          <Toggle label="Add scene chapters to the description" checked={settings.chapters} disabled={disabled} onChange={(v) => set("chapters", v)} />
        </div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={disabled}
            onChange={(e) => setReviewed(e.target.checked)}
            className="mt-0.5 size-3.5 shrink-0 accent-primary"
          />
          Captions match the audio (I played the render through)
        </label>
        {[...trimErrors, ...captionErrors].slice(0, 3).map((m) => (
          <p key={m} className="text-xs text-destructive">
            {m}
          </p>
        ))}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setItems(props.clips.map(toEditor));
                setSettings(props.settings);
                setReviewed(props.captionsReviewed);
              }}
            >
              Discard changes
            </Button>
          )}
          <Button
            disabled={disabled || !dirty || saving || captionErrors.length > 0 || trimErrors.length > 0}
            onClick={() => runSave(() => saveVideoEdit(props.videoId, payload))}
          >
            <SaveIcon />
            {saving ? "Saving…" : "Save edit"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ClipDetail({
  id,
  clip,
  disabled,
  errors,
  onChange,
}: {
  id: string;
  clip: EditorClip;
  disabled: boolean;
  errors: string[];
  onChange: (patch: Partial<EditorClip>) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const here = () => round1(player.current?.currentTime ?? 0);
  const end = clip.trimEnd ?? clip.sourceSeconds;

  return (
    <div className="grid gap-4 border-t p-3 md:grid-cols-2">
      <div className="grid content-start gap-2">
        <video ref={player} src={mediaUrl(clip.filePath)} controls preload="metadata" className="aspect-video w-full rounded border bg-black" />
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-start`}>Start (s)</Label>
            <Input
              id={`${id}-start`}
              type="number"
              min={0}
              step={0.1}
              value={clip.trimStart}
              disabled={disabled}
              onChange={(e) => onChange({ trimStart: Math.max(0, Number(e.target.value) || 0) })}
            />
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ trimStart: here() })}>
              Start at playhead
            </Button>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-end`}>End (s)</Label>
            <Input
              id={`${id}-end`}
              type="number"
              min={0}
              step={0.1}
              value={round1(end)}
              disabled={disabled}
              onChange={(e) => {
                const value = Number(e.target.value);
                onChange({ trimEnd: !value || (clip.sourceSeconds && value >= clip.sourceSeconds) ? null : value });
              }}
            />
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ trimEnd: here() })}>
              End at playhead
            </Button>
          </div>
        </div>
        {(clip.trimStart > 0 || clip.trimEnd !== null) && (
          <Button variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => onChange({ trimStart: 0, trimEnd: null })}>
            Reset trim
          </Button>
        )}
      </div>
      <div className="grid content-start gap-2">
        <Label htmlFor={`${id}-captions`} className="flex items-center gap-1.5">
          <CaptionsIcon className="size-4" />
          Captions for this scene
        </Label>
        {clip.captionsText === null ? (
          <p className="text-xs text-muted-foreground">Generated from the scene&apos;s dialogue when you save the edit. Edit them afterwards.</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              One per line, <code className="rounded bg-muted px-1">start-end | text</code>, timed against this clip (not the whole video), so
              trimming and reordering keep them in sync.
            </p>
            <Textarea
              id={`${id}-captions`}
              rows={7}
              value={clip.captionsText}
              disabled={disabled}
              onChange={(e) => onChange({ captionsText: e.target.value })}
              className="font-mono text-xs"
            />
            {errors.slice(0, 3).map((m) => (
              <p key={m} className="text-xs text-amber-400">
                {m}
              </p>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn("flex items-start gap-2", disabled && "opacity-60")}>
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
