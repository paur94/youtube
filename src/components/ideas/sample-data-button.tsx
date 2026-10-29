"use client";

import { FlaskConicalIcon, Trash2Icon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { loadSampleIdeas, removeSampleIdeas } from "@/server/actions/ideas";

export function SampleDataButton({
  mode,
  variant = "outline",
}: {
  mode: "load" | "remove";
  variant?: "outline" | "default" | "destructive";
}) {
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      try {
        const result = await (mode === "load" ? loadSampleIdeas() : removeSampleIdeas());
        if (result.ok) toast.success(result.message);
        else toast.error(result.message);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <Button variant={variant} onClick={run} disabled={pending}>
      {mode === "load" ? <FlaskConicalIcon /> : <Trash2Icon />}
      {mode === "load"
        ? pending
          ? "Loading…"
          : "Load sample ideas"
        : pending
          ? "Removing…"
          : "Remove sample ideas"}
    </Button>
  );
}
