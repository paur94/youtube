"use client";

import {
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  TriangleAlertIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { StoryEditor } from "@/components/stories/story-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { StoryContent } from "@/lib/stories";
import { generateStory, saveStoryEdits } from "@/server/actions/stories";

type Props = {
  storyId: string;
  content: StoryContent | null;
  latestRevision: number | null;
  targetDurationSeconds: number;
  claude: { configured: boolean; model: string };
};

const NETWORK_ERROR =
  "Lost contact with the server. If a revision appears in the history, the request still finished.";

export function StoryWorkspace({ storyId, content, latestRevision, targetDurationSeconds, claude }: Props) {
  const [draft, setDraft] = useState(content);
  const [version, setVersion] = useState(0);
  // Reset the editor whenever the server has a new revision; adjusting state during render
  // avoids an extra effect pass.
  const [syncedRevision, setSyncedRevision] = useState(latestRevision);
  if (latestRevision !== syncedRevision) {
    setSyncedRevision(latestRevision);
    setDraft(content);
    setVersion((v) => v + 1);
  }

  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [generating, startGenerating] = useTransition();
  const [saving, startSaving] = useTransition();

  const dirty = useMemo(
    () => draft !== null && content !== null && JSON.stringify(draft) !== JSON.stringify(content),
    [draft, content],
  );

  useEffect(() => {
    if (!dirty && !generating) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, generating]);

  function generate(revise: boolean) {
    setError(null);
    startGenerating(async () => {
      try {
        const result = await generateStory(storyId, revise ? notes : "");
        if (result.ok) {
          toast.success(result.message);
          setNotes("");
        } else {
          setError(result.message);
          toast.error("Story generation failed");
        }
      } catch {
        setError(NETWORK_ERROR);
      }
    });
  }

  function save() {
    if (!draft) return;
    startSaving(async () => {
      try {
        const result = await saveStoryEdits(storyId, JSON.stringify(draft));
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
      } catch {
        toast.error("Could not save. Your edits are still here; try again.");
      }
    });
  }

  function discard() {
    setDraft(content);
    setVersion((v) => v + 1);
  }

  const busy = generating || saving;

  return (
    <div className="grid min-w-0 gap-6">
      {!claude.configured && <NotConfiguredCard />}
      {generating && <GeneratingCard model={claude.model} revising={!!content} />}
      {error && !generating && (
        <Card className="border-destructive/50">
          <CardContent className="flex flex-wrap items-start gap-3">
            <TriangleAlertIcon className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Generation did not complete</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      {!draft ? (
        !generating && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                <SparklesIcon className="size-5 text-primary" />
              </div>
              <p className="font-medium">No story yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Claude will write the premise, story arc, narration, a scene-by-scene storyboard with
                visual prompts, sound and music cues, and a review checklist from this brief. It
                usually takes one to three minutes.
              </p>
              <Button onClick={() => generate(false)} disabled={!claude.configured || busy}>
                <WandSparklesIcon />
                Generate story
              </Button>
            </CardContent>
          </Card>
        )
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Revise with Claude</CardTitle>
              <CardDescription>
                Describe what to change, or write a completely new version. Each result is saved as a
                new revision; nothing is overwritten.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Textarea
                aria-label="Revision notes"
                rows={2}
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Make the ending funnier and add a counting song in scene 3"
                disabled={busy}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => generate(true)}
                  disabled={!claude.configured || busy || dirty || !notes.trim()}
                >
                  <WandSparklesIcon />
                  Revise with notes
                </Button>
                <Button variant="outline" onClick={() => generate(false)} disabled={!claude.configured || busy || dirty}>
                  <RefreshCwIcon />
                  Write a new version
                </Button>
                {dirty && (
                  <span className="text-xs text-muted-foreground">Save or discard your edits first.</span>
                )}
              </div>
            </CardContent>
          </Card>

          <StoryEditor
            value={draft}
            onChange={setDraft}
            version={version}
            targetDurationSeconds={targetDurationSeconds}
            disabled={busy}
          />

          {dirty && (
            <div className="sticky bottom-4 z-30 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-card/95 px-4 py-3 shadow-lg backdrop-blur">
              <p className="text-sm">
                Unsaved edits
                <span className="text-muted-foreground"> · saving creates revision {(latestRevision ?? 0) + 1}</span>
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={discard} disabled={saving}>
                  <Undo2Icon />
                  Discard
                </Button>
                <Button onClick={save} disabled={saving}>
                  {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
                  {saving ? "Saving…" : "Save revision"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GeneratingCard({ model, revising }: { model: string; revising: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Card className="border-primary/40" role="status" aria-live="polite">
      <CardContent className="flex items-center gap-4">
        <Loader2Icon className="size-6 shrink-0 animate-spin text-primary" />
        <div className="min-w-0">
          <p className="font-medium">{revising ? "Claude is writing a new revision…" : "Claude is writing your story…"}</p>
          <p className="text-sm text-muted-foreground">
            {model} · {seconds}s elapsed. This usually takes one to three minutes. Keep this tab
            open.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function NotConfiguredCard() {
  return (
    <Card className="border-amber-500/40">
      <CardContent className="flex items-start gap-3">
        <KeyRoundIcon className="mt-0.5 size-5 shrink-0 text-amber-400" />
        <div className="grid gap-1 text-sm">
          <p className="font-medium">Claude API key not configured</p>
          <p className="text-muted-foreground">
            You can write and save the brief, but generating needs an API key. Add{" "}
            <code className="rounded bg-muted px-1">ANTHROPIC_API_KEY=…</code> to{" "}
            <code className="rounded bg-muted px-1">.env.local</code> and restart{" "}
            <code className="rounded bg-muted px-1">npm run dev</code>. See the README for details.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
