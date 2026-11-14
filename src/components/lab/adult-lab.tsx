"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ImageIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { LabJob, LabProject } from "@/db/schema";
import {
  clampSeconds,
  LAB_ACTIVE_STATUSES,
  LAB_ASPECT_RATIOS,
  LAB_MAX_REFERENCES,
  LAB_MAX_SECONDS,
  LAB_MIN_SECONDS,
  type LabScene,
  type LabStory,
  newSceneId,
} from "@/lib/lab";
import { mediaUrl } from "@/lib/production";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/server/actions/ideas";
import {
  deleteLabJob,
  deleteLabProject,
  generateLabImage,
  generateLabStory,
  generateLabVideo,
  recheckLabJob,
  refreshLabJobs,
  removeLabReference,
  saveLabStory,
  setLabApproved,
  updateLabSettings,
} from "@/server/actions/lab";

type ProjectSummary = { id: string; topic: string; createdAt: Date };

const POLL_MS = 6000;
const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:scheme-dark [&_option]:bg-popover [&_option]:text-popover-foreground";

/** Runs server actions one after another in a transition, toasting the last result (or the first failure). */
function useSteps() {
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState<string | null>(null);
  function run(name: string, ...steps: (() => Promise<ActionResult | null>)[]) {
    setLabel(name);
    startTransition(async () => {
      try {
        let last: ActionResult | null = null;
        for (const step of steps) {
          const result = await step();
          if (!result) continue;
          if (!result.ok) {
            toast.error(result.message);
            return;
          }
          last = result;
        }
        if (last) toast.success(last.message);
      } catch {
        toast.error("Something went wrong. Please try again.");
      } finally {
        setLabel(null);
      }
    });
  }
  return { pending, label, run };
}

async function postUpload(form: FormData): Promise<ActionResult & { id?: string }> {
  const response = await fetch("/api/lab", { method: "POST", body: form });
  return response.json().catch(() => ({ ok: false, message: `Upload failed (HTTP ${response.status})` }));
}

export function AdultLab({ projects, project, jobs }: { projects: ProjectSummary[]; project: LabProject | null; jobs: LabJob[] }) {
  const router = useRouter();
  const steps = useSteps();

  // Poll while anything is generating; the action revalidates the page when a job changes.
  const active = jobs.some((j) => (LAB_ACTIVE_STATUSES as readonly string[]).includes(j.status));
  const projectId = project?.id;
  useEffect(() => {
    if (!active || !projectId) return;
    const timer = setInterval(() => void refreshLabJobs(projectId).catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [active, projectId]);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Project"
          className={cn(SELECT_CLASS, "max-w-full min-w-0 sm:w-96")}
          value={project?.id ?? "new"}
          onChange={(e) => router.push(`/adult?project=${e.target.value}`)}
        >
          <option value="new">+ New project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {/* ISO date: locale formatting differs between server and browser and breaks hydration. */}
              {p.topic.slice(0, 70)} · {new Date(p.createdAt).toISOString().slice(0, 10)}
            </option>
          ))}
        </select>
        {project && (
          <>
            <Button variant="outline" onClick={() => router.push("/adult?project=new")}>
              <PlusIcon /> New
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={steps.pending}
              onClick={() => {
                if (!confirm("Delete this project with its story, images and clips?")) return;
                steps.run("delete", async () => {
                  const result = await deleteLabProject(project.id);
                  if (result.ok) router.push("/adult");
                  return result;
                });
              }}
            >
              <Trash2Icon /> Delete
            </Button>
          </>
        )}
        {active && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" /> Generating, updates every few seconds
          </span>
        )}
      </div>

      {project ? (
        <>
          <SetupCard key={project.id} project={project} steps={steps} />
          {project.story ? (
            <StoryEditor key={`${project.id}:${project.storyVersion}`} project={project} story={project.story} jobs={jobs} steps={steps} />
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                {steps.label === "story" ? "GPT is writing the story…" : "No story yet. Generate one above."}
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <NewProjectCard steps={steps} />
      )}
    </div>
  );
}

type Steps = ReturnType<typeof useSteps>;

function NewProjectCard({ steps }: { steps: Steps }) {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("9:16");
  const [files, setFiles] = useState<File[]>([]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Topic and reference images</CardTitle>
        <CardDescription>GPT writes a story for adults from these; nothing is checked against the kids rules.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="lab-topic">Topic</Label>
          <Textarea
            id="lab-topic"
            rows={4}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. A tense late-night heist in a rain-soaked casino that goes wrong when one crew member double-crosses the others"
          />
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="lab-aspect">Format</Label>
            <select id="lab-aspect" className={SELECT_CLASS} value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              {LAB_ASPECT_RATIOS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lab-files">Reference images (optional, up to {LAB_MAX_REFERENCES})</Label>
            <Input
              id="lab-files"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, LAB_MAX_REFERENCES))}
            />
          </div>
        </div>
        {files.length > 0 && <Thumbs items={files.map((f) => ({ key: f.name + f.size, src: URL.createObjectURL(f), name: f.name }))} />}
        <div>
          <Button
            disabled={steps.pending || topic.trim().length < 3}
            onClick={() =>
              steps.run("story", async () => {
                const form = new FormData();
                form.set("topic", topic);
                form.set("aspectRatio", aspectRatio);
                files.forEach((f) => form.append("files", f));
                const created = await postUpload(form);
                if (!created.ok || !created.id) return created;
                router.push(`/adult?project=${created.id}`);
                return generateLabStory(created.id);
              })
            }
          >
            {steps.label === "story" ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {steps.label === "story" ? "Writing story…" : "Create and write story"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SetupCard({ project, steps }: { project: LabProject; steps: Steps }) {
  const [topic, setTopic] = useState(project.topic);
  const [aspectRatio, setAspectRatio] = useState(project.aspectRatio);
  const fileRef = useRef<HTMLInputElement>(null);
  const settingsDirty = topic !== project.topic;
  const saveSettings = () => (settingsDirty ? updateLabSettings(project.id, { topic, aspectRatio }) : Promise.resolve(null));

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Topic and reference images</CardTitle>
        <CardDescription>Reference images go to GPT, to every Grok image, and to Kling when a scene has no start frame.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Textarea aria-label="Topic" rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Format"
            className={SELECT_CLASS}
            value={aspectRatio}
            disabled={steps.pending}
            onChange={(e) => {
              // Saved right away: images and clips are generated with the project's saved format.
              const next = e.target.value;
              setAspectRatio(next);
              steps.run("settings", () => updateLabSettings(project.id, { topic: project.topic, aspectRatio: next }));
            }}
          >
            {LAB_ASPECT_RATIOS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          {settingsDirty && (
            <Button variant="outline" disabled={steps.pending} onClick={() => steps.run("settings", saveSettings)}>
              <SaveIcon /> Save
            </Button>
          )}
          <Button
            disabled={steps.pending}
            onClick={() => {
              if (project.story && !confirm("Replace the current story with a new one? Your edits to it will be lost.")) return;
              steps.run("story", saveSettings, () => generateLabStory(project.id));
            }}
          >
            {steps.label === "story" ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {steps.label === "story" ? "Writing story…" : project.story ? "Regenerate story" : "Generate story"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {project.references.map((ref) => (
            <div key={ref.id} className="group relative size-20 overflow-hidden rounded-lg border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mediaUrl(ref.filePath)} alt={ref.name} title={ref.name} className="size-full object-cover" />
              <button
                type="button"
                aria-label={`Remove ${ref.name}`}
                disabled={steps.pending}
                onClick={() => steps.run("ref", () => removeLabReference(project.id, ref.id))}
                className="absolute top-1 right-1 rounded-full bg-background/90 p-0.5 opacity-0 shadow group-hover:opacity-100 focus-visible:opacity-100"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
          {project.references.length < LAB_MAX_REFERENCES && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (!files.length) return;
                  steps.run("upload", () => {
                    const form = new FormData();
                    form.set("projectId", project.id);
                    files.forEach((f) => form.append("files", f));
                    return postUpload(form);
                  });
                }}
              />
              <Button variant="outline" className="size-20 flex-col" disabled={steps.pending} onClick={() => fileRef.current?.click()}>
                {steps.label === "upload" ? <Loader2Icon className="animate-spin" /> : <UploadIcon />}
                <span className="text-xs">Add</span>
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Thumbs({ items }: { items: { key: string; src: string; name: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((i) => (
        <div key={i.key} className="size-16 overflow-hidden rounded-lg border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={i.src} alt={i.name} className="size-full object-cover" />
        </div>
      ))}
    </div>
  );
}

function StoryEditor({ project, story: saved, jobs, steps }: { project: LabProject; story: LabStory; jobs: LabJob[]; steps: Steps }) {
  const [story, setStory] = useState(saved);
  const dirty = JSON.stringify(story) !== JSON.stringify(saved);
  const save = () => (dirty ? saveLabStory(project.id, story) : Promise.resolve(null));

  const setScene = (id: string, patch: Partial<LabScene>) =>
    setStory((s) => ({ ...s, scenes: s.scenes.map((sc) => (sc.id === id ? { ...sc, ...patch } : sc)) }));
  const moveScene = (index: number, delta: number) =>
    setStory((s) => {
      const scenes = [...s.scenes];
      const [scene] = scenes.splice(index, 1);
      scenes.splice(index + delta, 0, scene);
      return { ...s, scenes };
    });

  const totalSeconds = story.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            2. Story
            {project.approved ? <Badge>Approved</Badge> : <Badge variant="secondary">Draft</Badge>}
            {dirty && <Badge variant="outline">Unsaved changes</Badge>}
          </CardTitle>
          <CardDescription>
            Edit anything, then approve it to unlock image and clip generation. {story.scenes.length} scenes · {totalSeconds}s.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="lab-title">Title</Label>
            <Input id="lab-title" value={story.title} onChange={(e) => setStory({ ...story, title: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lab-logline">Logline</Label>
            <Textarea id="lab-logline" rows={2} value={story.logline} onChange={(e) => setStory({ ...story, logline: e.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label>Characters (their look is added to every image and clip prompt)</Label>
            {story.characters.map((c, i) => (
              <div key={i} className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input
                  aria-label="Name"
                  className="sm:w-48"
                  value={c.name}
                  onChange={(e) => setStory({ ...story, characters: story.characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                />
                <Textarea
                  aria-label="Look"
                  rows={2}
                  value={c.look}
                  onChange={(e) => setStory({ ...story, characters: story.characters.map((x, j) => (j === i ? { ...x, look: e.target.value } : x)) })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove character"
                  onClick={() => setStory({ ...story, characters: story.characters.filter((_, j) => j !== i) })}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <div>
              <Button variant="outline" size="sm" onClick={() => setStory({ ...story, characters: [...story.characters, { name: "", look: "" }] })}>
                <PlusIcon /> Character
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={steps.pending || !dirty} onClick={() => steps.run("save", save)}>
              <SaveIcon /> Save
            </Button>
            {project.approved ? (
              <Button variant="outline" disabled={steps.pending} onClick={() => steps.run("approve", save, () => setLabApproved(project.id, false))}>
                Back to draft
              </Button>
            ) : (
              <Button disabled={steps.pending} onClick={() => steps.run("approve", save, () => setLabApproved(project.id, true))}>
                <CheckIcon /> {dirty ? "Save and approve" : "Approve story"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {story.scenes.map((scene, index) => (
        <SceneCard
          key={scene.id}
          index={index}
          count={story.scenes.length}
          scene={scene}
          project={project}
          jobs={jobs.filter((j) => j.sceneId === scene.id)}
          steps={steps}
          onChange={(patch) => setScene(scene.id, patch)}
          onMove={(delta) => moveScene(index, delta)}
          onRemove={() => setStory({ ...story, scenes: story.scenes.filter((s) => s.id !== scene.id) })}
          save={save}
          saveWith={(patch) => {
            const next = { ...story, scenes: story.scenes.map((s) => (s.id === scene.id ? { ...s, ...patch } : s)) };
            setStory(next);
            steps.run("start", () => saveLabStory(project.id, next));
          }}
        />
      ))}

      <div>
        <Button
          variant="outline"
          onClick={() =>
            setStory({
              ...story,
              scenes: [
                ...story.scenes,
                { id: newSceneId(), title: "New scene", imagePrompt: "", videoPrompt: "", dialogue: "", durationSeconds: 5, startImageJobId: null },
              ],
            })
          }
        >
          <PlusIcon /> Add scene
        </Button>
      </div>
    </div>
  );
}

function SceneCard({
  index,
  count,
  scene,
  project,
  jobs,
  steps,
  onChange,
  onMove,
  onRemove,
  save,
  saveWith,
}: {
  index: number;
  count: number;
  scene: LabScene;
  project: LabProject;
  jobs: LabJob[];
  steps: Steps;
  onChange: (patch: Partial<LabScene>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  save: () => Promise<ActionResult | null>;
  saveWith: (patch: Partial<LabScene>) => void;
}) {
  const blocked = !project.approved;
  const field = `scene-${scene.id}`;
  const images = jobs.filter((j) => j.kind === "image");
  const videos = jobs.filter((j) => j.kind === "video");

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Scene {index + 1}</span>
        <Input aria-label="Scene title" className="max-w-xs flex-1" value={scene.title} onChange={(e) => onChange({ title: e.target.value })} />
        <div className="flex items-center gap-1.5">
          <Input
            aria-label="Seconds"
            type="number"
            min={LAB_MIN_SECONDS}
            max={LAB_MAX_SECONDS}
            className="w-18"
            value={scene.durationSeconds}
            onChange={(e) => onChange({ durationSeconds: clampSeconds(Number(e.target.value)) })}
          />
          <span className="text-xs text-muted-foreground">s</span>
        </div>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUpIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDownIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Remove scene" disabled={count === 1} onClick={onRemove}>
            <Trash2Icon />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${field}-image`}>Image prompt (Grok)</Label>
            <Textarea id={`${field}-image`} rows={4} value={scene.imagePrompt} onChange={(e) => onChange({ imagePrompt: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${field}-video`}>Motion prompt (Kling 4.0)</Label>
            <Textarea id={`${field}-video`} rows={3} value={scene.videoPrompt} onChange={(e) => onChange({ videoPrompt: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${field}-dialogue`}>Dialogue (one line each, “Name: line”; no narrator)</Label>
            <Textarea id={`${field}-dialogue`} rows={3} value={scene.dialogue} onChange={(e) => onChange({ dialogue: e.target.value })} />
          </div>
        </div>

        <div className="grid content-start gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={blocked || steps.pending}
              title={blocked ? "Approve the story first" : undefined}
              onClick={() => steps.run(`image:${scene.id}`, save, () => generateLabImage(project.id, scene.id))}
            >
              {steps.label === `image:${scene.id}` ? <Loader2Icon className="animate-spin" /> : <ImageIcon />} Generate image
            </Button>
            <Button
              disabled={blocked || steps.pending}
              title={blocked ? "Approve the story first" : undefined}
              onClick={() => steps.run(`video:${scene.id}`, save, () => generateLabVideo(project.id, scene.id))}
            >
              {steps.label === `video:${scene.id}` ? <Loader2Icon className="animate-spin" /> : <VideoIcon />} Generate clip
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {scene.startImageJobId
              ? "The clip starts from the image marked as start frame."
              : project.references.length
                ? "No start frame picked: the clip uses your reference images. Pick an image below to start from it."
                : "No start frame picked: the clip is generated from the prompt alone."}
          </p>

          {images.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {images.map((job) => {
                const isStart = scene.startImageJobId === job.id;
                return (
                  <JobTile key={job.id} job={job} steps={steps} highlight={isStart}>
                    {job.filePath && (
                      <Button
                        size="xs"
                        variant={isStart ? "default" : "secondary"}
                        disabled={steps.pending}
                        onClick={() => saveWith({ startImageJobId: isStart ? null : job.id })}
                      >
                        {isStart ? "Start frame ✓" : "Use as start"}
                      </Button>
                    )}
                  </JobTile>
                );
              })}
            </div>
          )}
          {videos.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {videos.map((job) => (
                <JobTile key={job.id} job={job} steps={steps} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  in_progress: "Generating",
  failed: "Failed",
  nsfw: "Blocked by moderation",
  canceled: "Canceled",
  timed_out: "Timed out",
};

function JobTile({ job, steps, highlight, children }: { job: LabJob; steps: Steps; highlight?: boolean; children?: React.ReactNode }) {
  const running = (LAB_ACTIVE_STATUSES as readonly string[]).includes(job.status);
  const src = job.filePath ? mediaUrl(job.filePath) : null;
  return (
    <div className={cn("grid gap-1.5 rounded-lg border p-1.5", highlight && "border-primary ring-2 ring-primary/30")}>
      <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
        {src && job.kind === "video" ? (
          <video src={src} controls preload="metadata" className="size-full object-contain" />
        ) : src ? (
          <a href={src} target="_blank" rel="noreferrer" className="size-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="size-full object-contain" />
          </a>
        ) : running ? (
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <p className="p-2 text-center text-[11px] text-destructive">{job.error ?? STATUS_LABEL[job.status] ?? job.status}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        {job.status !== "completed" && (
          <span className="text-[11px] text-muted-foreground">{STATUS_LABEL[job.status] ?? job.status}</span>
        )}
        {job.estimatedCostUsd && <span className="text-[11px] text-muted-foreground">${Number(job.estimatedCostUsd).toFixed(2)}</span>}
        <div className="ml-auto flex items-center gap-1">
          {job.status === "timed_out" && (
            <Button
              size="xs"
              variant="secondary"
              disabled={steps.pending}
              title="Ask the provider again; this does not resubmit or cost anything"
              onClick={() => steps.run("recheck", () => recheckLabJob(job.id))}
            >
              {steps.label === "recheck" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Check again
            </Button>
          )}
          {children}
          {!running && (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Delete"
              disabled={steps.pending}
              onClick={() => {
                if (confirm("Delete this output?")) steps.run("delete-job", () => deleteLabJob(job.id));
              }}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
