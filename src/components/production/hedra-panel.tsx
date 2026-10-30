"use client";

import { KeyRoundIcon, MicIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_HEDRA_RESOLUTION, HEDRA_AUDIO_TYPES, HEDRA_MODEL, HEDRA_RESOLUTIONS } from "@/lib/hedra";

const TRIGGER = "w-full min-w-0 *:data-[slot=select-value]:block *:data-[slot=select-value]:truncate";
const ACCEPT = [...Object.keys(HEDRA_AUDIO_TYPES), ".mp3", ".wav", ".m4a"].join(",");

/** Hedra Character 3: animates an approved image so its character speaks an uploaded audio file. */
export function HedraPanel({
  sceneId,
  configured,
  startImages,
  blocked,
}: {
  sceneId: string;
  configured: boolean;
  startImages: { id: string; label: string }[];
  blocked: boolean;
}) {
  const [startAssetId, setStartAssetId] = useState(startImages[0]?.id ?? "");
  const [resolution, setResolution] = useState<string>(DEFAULT_HEDRA_RESOLUTION);
  const [audio, setAudio] = useState<File | null>(null);
  // Remounts the file input to clear it after a submit.
  const [inputKey, setInputKey] = useState(0);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const id = useId();

  function submit() {
    if (!audio) return;
    startTransition(async () => {
      try {
        const form = new FormData();
        form.set("sceneId", sceneId);
        form.set("startAssetId", startAssetId);
        form.set("resolution", resolution);
        form.set("audio", audio);
        const response = await fetch("/api/hedra", { method: "POST", body: form });
        const result: { ok: boolean; message: string } = await response
          .json()
          .catch(() => ({ ok: false, message: `Upload failed (HTTP ${response.status})` }));
        if (result.ok) {
          toast.success(result.message);
          setAudio(null);
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

  return (
    <section className="grid gap-3 rounded-lg border border-sky-500/30 p-4">
      <header className="flex items-center gap-2">
        <MicIcon className="size-4 text-sky-400" />
        <h3 className="font-medium">Talking character: {HEDRA_MODEL.label.split(" (")[0]} (testing)</h3>
      </header>
      {!configured ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <p>
            Not configured. Add <code className="rounded bg-muted px-1">HEDRA_API_KEY</code> from{" "}
            <a href="https://www.hedra.com/api-profile" target="_blank" rel="noreferrer" className="underline">
              Hedra
            </a>{" "}
            to <code className="rounded bg-muted px-1">.env.local</code> and restart. It is paid from the Hedra API
            wallet, not studio credits.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Animates an approved image so the character speaks or sings your audio. The clip runs as long as the audio.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`${id}-start`}>Start image</Label>
              {startImages.length ? (
                <Select value={startAssetId} onValueChange={setStartAssetId}>
                  <SelectTrigger id={`${id}-start`} className={TRIGGER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {startImages.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Approve a keyframe image for this scene (or a character reference) first.
                </p>
              )}
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor={`${id}-resolution`}>Resolution</Label>
              <Select value={resolution} onValueChange={setResolution}>
                <SelectTrigger id={`${id}-resolution`} className={TRIGGER}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HEDRA_RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-1.5 sm:col-span-2">
              <Label htmlFor={`${id}-audio`}>Voice audio (MP3, WAV or M4A)</Label>
              <Input
                key={inputKey}
                id={`${id}-audio`}
                type="file"
                accept={ACCEPT}
                onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <Button className="w-fit" disabled={pending || blocked || !startAssetId || !audio} onClick={submit}>
            <SparklesIcon />
            {pending ? "Uploading…" : "Generate with Hedra"}
          </Button>
        </>
      )}
    </section>
  );
}
