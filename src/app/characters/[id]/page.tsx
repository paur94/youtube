import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import {
  CharacterDialogButton,
  CharacterStatusActions,
  DeleteCharacterButton,
  ReferenceCard,
} from "@/components/characters/character-actions";
import { PageHeader } from "@/components/page-header";
import { CharacterStatusBadge } from "@/components/production/badges";
import { CopyButton } from "@/components/production/copy-button";
import { dateTimeFormat } from "@/components/production/format";
import { ImportAssetDialog } from "@/components/production/import-asset-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MODULES } from "@/lib/navigation";
import { findPromptConcerns } from "@/lib/production";
import { getCharacter, listCharacters } from "@/server/queries/production";

export const metadata: Metadata = { title: MODULES.characters.label };

export default function CharacterPage({ params }: PageProps<"/characters/[id]">) {
  return (
    <div className="grid gap-6">
      <Link
        href="/characters"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" />
        All characters
      </Link>
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <CharacterData params={params} />
      </Suspense>
    </div>
  );
}

async function CharacterData({ params }: Pick<PageProps<"/characters/[id]">, "params">) {
  await connection();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [character, summaries] = await Promise.all([getCharacter(id), listCharacters()]);
  if (!character) notFound();
  const sceneCount = summaries.find((s) => s.character.id === id)?.sceneCount ?? 0;
  const concerns = findPromptConcerns(`${character.name} ${character.visualDescription}`);

  return (
    <>
      <PageHeader title={character.name} description={character.role || "Character"} icon={MODULES.characters.icon}>
        <CharacterStatusBadge status={character.status} />
        <CharacterStatusActions id={character.id} status={character.status} />
        <CharacterDialogButton character={character} />
        <DeleteCharacterButton id={character.id} name={character.name} appearances={sceneCount} />
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="grid min-w-0 gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Consistent description</CardTitle>
              <CardDescription>Appended to every scene prompt that includes {character.name}.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-sm whitespace-pre-line">{character.visualDescription}</p>
              {concerns.length > 0 && <p className="text-xs text-rose-300">{concerns.join(". ")}.</p>}
              <CopyButton text={character.visualDescription} label="Copy description" />
              {character.description && (
                <div>
                  <p className="text-xs text-muted-foreground">Personality</p>
                  <p className="text-sm whitespace-pre-line">{character.description}</p>
                </div>
              )}
              {character.notes && (
                <div>
                  <p className="text-xs text-muted-foreground">Notes</p>
                  <p className="text-sm whitespace-pre-line">{character.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reference images</CardTitle>
              <CardDescription>
                Approved references can be used as start frames for image-to-video and uploaded to Higgsfield
                manually. Rejected images are kept.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ImportAssetDialog
                target={{ characterId: character.id }}
                label="Upload reference image"
                title={`Reference image for ${character.name}`}
                description="Use an original design you created or generated. The image is stored locally and needs your approval before it can be reused."
              />
              {character.references.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reference images yet.</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {character.references.map((ref) => (
                    <ReferenceCard
                      key={ref.id}
                      characterId={character.id}
                      isPrimary={character.primaryReferenceId === ref.id}
                      reference={{
                        id: ref.id,
                        status: ref.status,
                        filePath: ref.filePath,
                        revision: ref.revision,
                        originalName: ref.originalName,
                        createdAt: dateTimeFormat.format(ref.createdAt),
                      }}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Appearances</CardTitle>
            <CardDescription>
              {sceneCount} production {sceneCount === 1 ? "scene" : "scenes"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {character.appearances.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not linked to any story yet.</p>
            ) : (
              <ul className="grid gap-1.5 text-sm">
                {character.appearances.map((a) => (
                  <li key={a.storyId}>
                    <Link href={`/stories/${a.storyId}`} className="hover:text-primary">
                      {a.generatedTitle ?? a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
