"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useAction } from "@/components/production/use-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TRAFFIC_SOURCE_LABELS, TRAFFIC_SOURCES } from "@/lib/shorts";
import { addShortMetrics, deleteShortMetrics } from "@/server/actions/shorts";

const FIELDS = [
  { name: "views", label: "Views", step: 1 },
  { name: "averageViewDurationSeconds", label: "Avg view duration (s)", step: 0.1 },
  { name: "viewedPercent", label: "Viewed (%) vs swiped away", step: 0.1 },
  { name: "averagePercentageViewed", label: "Avg % viewed (retention)", step: 0.1 },
  { name: "likes", label: "Likes", step: 1 },
  { name: "subscribersGained", label: "Subscribers gained", step: 1 },
] as const;

export function AddMetricsButton({ shortId, title }: { shortId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = useId();

  function submit(data: FormData) {
    startTransition(async () => {
      try {
        const result = await addShortMetrics(shortId, null, data);
        if (result?.ok) {
          toast.success(result.message);
          setOpen(false);
        } else if (result) toast.error(result.message);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add numbers
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a snapshot</DialogTitle>
            <DialogDescription>
              Copy the numbers for “{title}” from YouTube Studio. Leave a field empty when you don&apos;t have it: empty is
              stored as “not entered”, never as zero.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(new FormData(e.currentTarget));
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-date`}>Numbers as of</Label>
              <Input id={`${id}-date`} name="capturedAt" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.name} className="grid gap-1.5">
                  <Label htmlFor={`${id}-${f.name}`}>{f.label}</Label>
                  <Input id={`${id}-${f.name}`} name={f.name} type="number" min={0} step={f.step} />
                </div>
              ))}
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Traffic sources (% of views)</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                {TRAFFIC_SOURCES.map((s) => (
                  <div key={s} className="grid gap-1.5">
                    <Label htmlFor={`${id}-t-${s}`} className="text-xs">
                      {TRAFFIC_SOURCE_LABELS[s]}
                    </Label>
                    <Input id={`${id}-t-${s}`} name={`traffic_${s}`} type="number" min={0} max={100} step={0.1} />
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-notes`}>Notes</Label>
              <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={2000} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save snapshot"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function DeleteMetricsButton({ id }: { id: string }) {
  const [pending, run] = useAction();
  return (
    <Button size="icon" variant="ghost" className="size-7" aria-label="Delete snapshot" disabled={pending} onClick={() => run(() => deleteShortMetrics(id))}>
      <Trash2Icon />
    </Button>
  );
}
