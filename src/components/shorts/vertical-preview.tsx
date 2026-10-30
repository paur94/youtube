"use client";

import { PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { CaptionCue, VideoSettings } from "@/lib/shorts";
import { CAPTION_FONT_SIZE, computeFraming, HOOK_FONT_SIZE, OUT_H, OUT_W, overlayMargins } from "@/lib/short-video";

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

/**
 * Browser simulation of the 9:16 render using the same framing maths as FFmpeg, so framing,
 * captions and hook can be judged before rendering. It plays the original clip; nothing is written.
 */
export function VerticalPreview({
  src,
  settings,
  captions,
  hook,
  hookSeconds,
  onDimensions,
}: {
  src: string;
  settings: VideoSettings;
  captions: CaptionCue[];
  hook: string;
  hookSeconds: number;
  onDimensions?: (width: number, height: number) => void;
}) {
  const fg = useRef<HTMLVideoElement>(null);
  const bg = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [time, setTime] = useState(0);
  const [boxWidth, setBoxWidth] = useState(270);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const framing = dims ? computeFraming(dims.w, dims.h, settings) : null;
  const unit = boxWidth / OUT_W;
  const margins = framing ? overlayMargins(framing) : null;
  const cue = settings.burnCaptions ? captions.find((c) => time >= c.start && time < c.end) : undefined;
  const showHook = settings.showHook && hook.trim() && time < hookSeconds;

  function sync() {
    const a = fg.current;
    const b = bg.current;
    if (!a) return;
    setTime(a.currentTime);
    if (b && Math.abs(b.currentTime - a.currentTime) > 0.3) b.currentTime = a.currentTime;
  }

  return (
    <div className="grid gap-2">
    <div ref={box} className="relative aspect-9/16 w-full overflow-hidden rounded-md border bg-black">
      {framing && !framing.fillsFrame && (
        <video
          ref={bg}
          src={src}
          muted
          playsInline
          preload="metadata"
          aria-hidden
          className="absolute inset-0 size-full scale-110 object-cover opacity-80 blur-xl brightness-75"
        />
      )}
      <div
        className="absolute overflow-hidden"
        style={
          framing
            ? {
                left: pct(framing.offsetX, OUT_W),
                top: pct(framing.offsetY, OUT_H),
                width: pct(framing.visibleW, OUT_W),
                height: pct(framing.visibleH, OUT_H),
              }
            : { inset: 0 }
        }
      >
        <video
          ref={fg}
          src={src}
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDims({ w: v.videoWidth, h: v.videoHeight });
            setDuration(v.duration);
            onDimensions?.(v.videoWidth, v.videoHeight);
          }}
          onTimeUpdate={sync}
          onSeeked={sync}
          onPlay={() => {
            setPlaying(true);
            void bg.current?.play().catch(() => undefined);
          }}
          onPause={() => {
            setPlaying(false);
            bg.current?.pause();
          }}
          className="absolute max-w-none"
          style={
            framing
              ? {
                  width: pct(framing.scaledW, framing.visibleW),
                  height: pct(framing.scaledH, framing.visibleH),
                  left: `-${pct(framing.cropX, framing.visibleW)}`,
                  top: `-${pct(framing.cropY, framing.visibleH)}`,
                }
              : { inset: 0, width: "100%", height: "100%", objectFit: "contain" }
          }
        />
      </div>
      {margins && showHook && (
        <p
          className="pointer-events-none absolute inset-x-[7%] text-center leading-tight font-bold text-[#FFE100]"
          style={{ top: margins.hookMargin * unit, fontSize: HOOK_FONT_SIZE * unit, WebkitTextStroke: `${unit * 3}px black`, paintOrder: "stroke" }}
        >
          {hook}
        </p>
      )}
      {margins && cue && (
        <p
          className="pointer-events-none absolute inset-x-[8%] text-center leading-tight font-bold text-white"
          style={{ bottom: margins.captionMargin * unit, fontSize: CAPTION_FONT_SIZE * unit, WebkitTextStroke: `${unit * 3}px black`, paintOrder: "stroke" }}
        >
          {cue.text}
        </p>
      )}
    </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-7"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            const v = fg.current;
            if (!v) return;
            if (v.paused) void v.play();
            else v.pause();
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          aria-label="Position"
          onChange={(e) => {
            if (fg.current) fg.current.currentTime = Number(e.target.value);
          }}
          className="h-1 flex-1 accent-primary"
        />
        <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{time.toFixed(1)}s</span>
      </div>
    </div>
  );
}
