"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import type { ActionResult } from "@/server/actions/ideas";

export function useAction() {
  const [pending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult>, onOk?: () => void) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          toast.success(result.message);
          onOk?.();
        } else {
          toast.error(result.message);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }
  return [pending, run] as const;
}
