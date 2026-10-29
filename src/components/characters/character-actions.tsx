"use client";

import { CheckCircle2Icon, PencilIcon, PlusIcon, StarIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AssetPreview } from "@/components/production/asset-preview";
import { AssetStatusBadge } from "@/components/production/badges";
import { useAction } from "@/components/production/use-action";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Character } from "@/db/schema";
import type { AssetStatus, CharacterStatus } from "@/lib/production";
import { deleteCharacter, setCharacterStatus, setPrimaryReference } from "@/server/actions/characters";
import { reviewAsset } from "@/server/actions/production";

import { CharacterForm } from "./character-form";

export function CharacterDialogButton({ character }: { character?: Character }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={character ? "outline" : "default"} onClick={() => setOpen(true)}>
        {character ? <PencilIcon /> : <PlusIcon />}
        {character ? "Edit" : "New character"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{character ? `Edit ${character.name}` : "New character"}</DialogTitle>
            <DialogDescription>
              Design original characters only: no existing franchises, mascots or a living artist&apos;s signature
              style.
            </DialogDescription>
          </DialogHeader>
          {open && <CharacterForm character={character} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CharacterStatusActions({ id, status }: { id: string; status: CharacterStatus }) {
  const [pending, run] = useAction();
  return (
    <>
      {status !== "approved" && (
        <Button disabled={pending} onClick={() => run(() => setCharacterStatus(id, "approved"))}>
          <CheckCircle2Icon />
          Approve for reuse
        </Button>
      )}
      {status === "approved" && (
        <Button variant="outline" disabled={pending} onClick={() => run(() => setCharacterStatus(id, "draft"))}>
          Back to draft
        </Button>
      )}
      {status !== "archived" && (
        <Button variant="ghost" disabled={pending} onClick={() => run(() => setCharacterStatus(id, "archived"))}>
          Archive
        </Button>
      )}
    </>
  );
}

export function DeleteCharacterButton({ id, name, appearances }: { id: string; name: string; appearances: number }) {
  const [open, setOpen] = useState(false);
  const [pending, run] = useAction();
  const router = useRouter();
  return (
    <>
      <Button variant="ghost" size="icon" aria-label="Delete character" onClick={() => setOpen(true)} disabled={pending}>
        <Trash2Icon />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {appearances > 0
                ? `${name} is linked to ${appearances} ${appearances === 1 ? "scene" : "scenes"}; those links are removed and their prompts lose this description. Consider archiving instead. `
                : ""}
              Reference image records are removed; the files stay on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => run(() => deleteCharacter(id), () => router.push("/characters"))}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ReferenceCard({
  characterId,
  reference,
  isPrimary,
}: {
  characterId: string;
  reference: { id: string; status: AssetStatus; filePath: string | null; revision: number; createdAt: string; originalName: string | null };
  isPrimary: boolean;
}) {
  const [pending, run] = useAction();
  return (
    <article className="grid content-start gap-2 rounded-lg border bg-background/40 p-2.5">
      <AssetPreview kind="image" filePath={reference.filePath} className="aspect-square" />
      <div className="flex flex-wrap items-center gap-1.5">
        <AssetStatusBadge status={reference.status} />
        <Badge variant="outline">r{reference.revision}</Badge>
        {isPrimary && (
          <Badge className="bg-primary text-primary-foreground">
            <StarIcon />
            Primary
          </Badge>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground" title={reference.originalName ?? ""}>
        {reference.createdAt}
        {reference.originalName && ` · ${reference.originalName}`}
      </p>
      <div className="flex flex-wrap gap-1">
        {reference.status !== "approved" && (
          <Button size="sm" disabled={pending} onClick={() => run(() => reviewAsset(reference.id, { decision: "approved" }))}>
            <CheckCircle2Icon />
            Approve
          </Button>
        )}
        {reference.status === "approved" && !isPrimary && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setPrimaryReference(characterId, reference.id))}>
            <StarIcon />
            Make primary
          </Button>
        )}
        {reference.status !== "rejected" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => reviewAsset(reference.id, { decision: "rejected" }))}>
            <XCircleIcon />
            Reject
          </Button>
        )}
      </div>
    </article>
  );
}
