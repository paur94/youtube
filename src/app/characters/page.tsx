import { SmileIcon, UserRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { CharacterDialogButton, DeleteCharacterButton } from "@/components/characters/character-actions";
import { PageHeader } from "@/components/page-header";
import { CharacterStatusBadge } from "@/components/production/badges";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { mediaUrl } from "@/lib/production";
import { listCharacters } from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.characters.label };

export default function CharactersPage() {
  return (
    <div className="grid gap-6">
      <PageHeader title={MODULES.characters.label} description={MODULES.characters.description} icon={MODULES.characters.icon}>
        <CharacterDialogButton />
      </PageHeader>
      <Suspense
        fallback={
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        }
      >
        <CharactersData />
      </Suspense>
    </div>
  );
}

async function CharactersData() {
  await connection();
  const rows = await listCharacters();

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <SmileIcon className="size-5 text-primary" />
          </div>
          <p className="font-medium">No characters yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Characters are added automatically when you create a production plan from an approved story, or you can add
            them here. Approve a character to reuse the same look across episodes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(({ character, primaryFilePath, referenceCount, storyCount, sceneCount }) => (
        <Card key={character.id} className="relative h-full gap-3 py-4 transition-colors hover:border-primary/40">
          <CardContent className="flex gap-3 px-4">
            <div className="size-16 shrink-0 overflow-hidden rounded-lg border bg-muted">
              {primaryFilePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl(primaryFilePath)} alt="" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-muted-foreground">
                  <UserRoundIcon className="size-6" />
                </div>
              )}
            </div>
            <div className="grid min-w-0 content-start gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={`/characters/${character.id}`} className="font-medium after:absolute after:inset-0 hover:text-primary">
                  {character.name}
                </Link>
                <CharacterStatusBadge status={character.status} />
              </div>
              {character.role && <p className="text-xs text-muted-foreground">{character.role}</p>}
              <p className="line-clamp-2 text-xs text-muted-foreground">{character.visualDescription}</p>
              {character.looks.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  + {character.looks.map((l) => l.label).join(", ")}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                {storyCount} {storyCount === 1 ? "story" : "stories"} · {sceneCount} {sceneCount === 1 ? "scene" : "scenes"} ·{" "}
                {referenceCount} {referenceCount === 1 ? "reference" : "references"}
              </p>
            </div>
            <DeleteCharacterButton
              id={character.id}
              name={character.name}
              appearances={sceneCount}
              className="ml-auto self-start relative z-10 shrink-0 text-muted-foreground hover:text-destructive"
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
