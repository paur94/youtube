"use client";

import { useEffect, useRef, useState } from "react";

import { OVERLAY_STYLE, overlayLayout, overlayOpacityAt, type SceneOverlay } from "@/lib/overlays";

/**
 * A clip with its text overlays drawn on top, so their timing can be checked before Final assembly.
 * The SVG uses the clip's own pixel size and the same layout as the FFmpeg render; like the video,
 * it is scaled to fit the box. The font is a stand-in for the bundled one.
 */
export function OverlayVideo({
  src,
  overlays,
  className,
  controls,
}: {
  src: string;
  overlays: SceneOverlay[];
  className: string;
  controls: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      setTime(el.currentTime);
      if (!el.paused && !el.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onSize = () => {
      if (el.videoWidth && el.videoHeight) setFrame({ width: el.videoWidth, height: el.videoHeight });
    };
    onSize();
    el.addEventListener("play", onPlay);
    el.addEventListener("seeked", tick);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("loadedmetadata", onSize);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("seeked", tick);
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("loadedmetadata", onSize);
    };
  }, []);

  return (
    <div className="relative">
      <video ref={video} src={src} className={className} controls={controls} muted={!controls} preload="metadata" playsInline />
      {frame && (
        <svg
          viewBox={`0 0 ${frame.width} ${frame.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden
        >
          {overlays.map((overlay) => {
            const opacity = overlayOpacityAt(overlay, time);
            if (!opacity) return null;
            const l = overlayLayout(overlay, frame);
            const style = OVERLAY_STYLE[overlay.type];
            return (
              <g key={overlay.id} transform={`translate(${l.x} ${l.y})`} opacity={opacity}>
                <rect width={l.boxWidth} height={l.boxHeight} rx={l.radius} fill={style.fill} fillOpacity={style.alpha} />
                {l.tailHeight > 0 && (
                  <polygon
                    points={`${l.tailFrom},${l.boxHeight - 1} ${l.tailTo},${l.boxHeight - 1} ${l.tailTip},${l.boxHeight + l.tailHeight}`}
                    fill={style.fill}
                  />
                )}
                {l.lines.map((line, i) => (
                  <text
                    key={i}
                    x={l.boxWidth / 2}
                    y={l.paddingY + i * l.lineHeight + l.lineHeight / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={l.fontSize}
                    fontFamily='"Varela Round", ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif'
                    fill={style.text}
                  >
                    {line}
                  </text>
                ))}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
