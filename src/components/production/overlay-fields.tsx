"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MAX_OVERLAYS,
  OVERLAY_POSITION_LABELS,
  OVERLAY_POSITIONS,
  OVERLAY_TEXT_MAX,
  OVERLAY_TYPE_LABELS,
  OVERLAY_TYPES,
  type OverlayPosition,
  type OverlayType,
  type SceneOverlay,
} from "@/lib/overlays";

type Row = Omit<SceneOverlay, "start" | "end"> & { start: string; end: string };

const toNumber = (value: string) => (value.trim() === "" || Number.isNaN(Number(value)) ? null : Number(value));

/** The scene's text overlays, posted with the scene form as JSON in the "overlays" field. */
export function OverlayFields({
  id,
  initial,
  durationSeconds,
  error,
}: {
  id: string;
  initial: SceneOverlay[];
  durationSeconds: number;
  error?: string[];
}) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((o) => ({ ...o, start: String(o.start), end: String(o.end) })));
  const update = (index: number, patch: Partial<Row>) => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const payload = rows.map((r) => ({ ...r, start: toNumber(r.start), end: toNumber(r.end) }));

  function add() {
    setRows([
      ...rows,
      { id: crypto.randomUUID(), type: "bubble", text: "", position: "top-right", start: "0", end: String(Math.min(3, durationSeconds)) },
    ]);
  }

  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-sm font-medium">Overlays (added in post)</legend>
      <input type="hidden" name="overlays" value={JSON.stringify(payload)} />
      {rows.length > 0 && (
        <div className="grid gap-2">
          {rows.map((row, i) => (
            <div key={row.id} className="grid gap-2 rounded-md border bg-background/40 p-2 sm:grid-cols-[8.5rem_1fr]">
              <Select value={row.type} onValueChange={(v) => update(i, { type: v as OverlayType })}>
                <SelectTrigger aria-label={`Overlay ${i + 1} type`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERLAY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {OVERLAY_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id={i === 0 ? `${id}-overlay-text` : undefined}
                aria-label={`Overlay ${i + 1} text`}
                value={row.text}
                maxLength={OVERLAY_TEXT_MAX}
                placeholder="e.g. Working late. Love you."
                onChange={(e) => update(i, { text: e.target.value })}
              />
              <Select value={row.position} onValueChange={(v) => update(i, { position: v as OverlayPosition })}>
                <SelectTrigger aria-label={`Overlay ${i + 1} position`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OVERLAY_POSITIONS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {OVERLAY_POSITION_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Input
                  aria-label={`Overlay ${i + 1} start (s)`}
                  type="number"
                  min={0}
                  max={durationSeconds}
                  step={0.1}
                  value={row.start}
                  onChange={(e) => update(i, { start: e.target.value })}
                  className="w-20"
                />
                to
                <Input
                  aria-label={`Overlay ${i + 1} end (s)`}
                  type="number"
                  min={0}
                  max={durationSeconds}
                  step={0.1}
                  value={row.end}
                  onChange={(e) => update(i, { end: e.target.value })}
                  className="w-20"
                />
                s
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <Trash2Icon />
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button type="button" size="sm" variant="outline" disabled={rows.length >= MAX_OVERLAYS} onClick={add}>
          <PlusIcon />
          Add overlay
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Not sent to AI models. Burned in during Final assembly. Times are seconds into this scene&apos;s clip.
      </p>
      {error?.[0] && <p className="text-xs text-destructive">{error[0]}</p>}
    </fieldset>
  );
}
