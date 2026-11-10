"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VISUAL_STYLE_PRESETS } from "@/lib/stories";

/** Fills a visual style field with a preset; shows "Custom" once the text no longer matches one. */
export function VisualStylePreset({ value, onSelect }: { value: string; onSelect: (style: string) => void }) {
  const current = VISUAL_STYLE_PRESETS.find((p) => p.style === value.trim())?.style ?? "";
  return (
    <Select value={current} onValueChange={onSelect}>
      <SelectTrigger aria-label="Visual style preset" className="w-full min-w-0">
        <SelectValue placeholder="Custom: choose a preset…" />
      </SelectTrigger>
      <SelectContent>
        {VISUAL_STYLE_PRESETS.map((p) => (
          <SelectItem key={p.style} value={p.style}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
