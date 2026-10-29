"use client";

import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { IdeaFormDialog } from "@/components/ideas/idea-form-dialog";
import { Button } from "@/components/ui/button";

export function NewIdeaButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon />
        New idea
      </Button>
      <IdeaFormDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
