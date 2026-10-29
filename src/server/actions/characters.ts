"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { assets, characters } from "@/db/schema";
import { CHARACTER_STATUSES, type CharacterFormState, parseCharacterForm } from "@/lib/production";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check to every action
// before deploying anywhere reachable from the network.

const idSchema = z.uuid();

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function revalidateCharacters(id?: string) {
  revalidatePath("/characters");
  if (id) revalidatePath(`/characters/${id}`);
  // Prompts in the Production Studio include character descriptions.
  revalidatePath("/production", "layout");
}

export async function createCharacter(_prev: CharacterFormState, formData: FormData): Promise<CharacterFormState> {
  const parsed = parseCharacterForm(formData);
  if (!parsed.success) return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };
  try {
    await db.insert(characters).values(parsed.data);
  } catch (error) {
    console.error("createCharacter failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateCharacters();
  return { ok: true, message: "Character added" };
}

export async function updateCharacter(
  id: string,
  _prev: CharacterFormState,
  formData: FormData,
): Promise<CharacterFormState> {
  const characterId = idSchema.safeParse(id);
  const parsed = parseCharacterForm(formData);
  if (!characterId.success) return { ok: false, message: "Invalid character id" };
  if (!parsed.success) return { ok: false, errors: z.flattenError(parsed.error).fieldErrors };

  let updated: { id: string }[];
  try {
    updated = await db
      .update(characters)
      .set(parsed.data)
      .where(eq(characters.id, characterId.data))
      .returning({ id: characters.id });
  } catch (error) {
    console.error("updateCharacter failed", error);
    return { ok: false, message: DB_ERROR };
  }
  if (updated.length === 0) return { ok: false, message: "Character not found" };
  revalidateCharacters(characterId.data);
  return { ok: true, message: "Character saved. New prompts use the updated description." };
}

export async function setCharacterStatus(id: string, status: string): Promise<ActionResult> {
  const characterId = idSchema.safeParse(id);
  const next = z.enum(CHARACTER_STATUSES).safeParse(status);
  if (!characterId.success || !next.success) return { ok: false, message: "Invalid request" };
  try {
    await db.update(characters).set({ status: next.data }).where(eq(characters.id, characterId.data));
  } catch (error) {
    console.error("setCharacterStatus failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateCharacters(characterId.data);
  const labels = { approved: "Character approved for reuse", draft: "Moved back to draft", archived: "Character archived" };
  return { ok: true, message: labels[next.data] };
}

export async function deleteCharacter(id: string): Promise<ActionResult> {
  const characterId = idSchema.safeParse(id);
  if (!characterId.success) return { ok: false, message: "Invalid character id" };
  try {
    await db.delete(characters).where(eq(characters.id, characterId.data));
  } catch (error) {
    console.error("deleteCharacter failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateCharacters();
  return { ok: true, message: "Character deleted. Its reference image files stay in the media folder." };
}

/** The primary reference must be one of the character's own approved images. */
export async function setPrimaryReference(characterId: string, assetId: string): Promise<ActionResult> {
  const id = idSchema.safeParse(characterId);
  const ref = idSchema.safeParse(assetId);
  if (!id.success || !ref.success) return { ok: false, message: "Invalid request" };
  try {
    const [asset] = await db
      .select({ status: assets.status, kind: assets.kind })
      .from(assets)
      .where(and(eq(assets.id, ref.data), eq(assets.characterId, id.data)));
    if (!asset) return { ok: false, message: "Reference not found" };
    if (asset.kind !== "image" || asset.status !== "approved") {
      return { ok: false, message: "Approve the image before making it the primary reference" };
    }
    await db.update(characters).set({ primaryReferenceId: ref.data }).where(eq(characters.id, id.data));
  } catch (error) {
    console.error("setPrimaryReference failed", error);
    return { ok: false, message: DB_ERROR };
  }
  revalidateCharacters(id.data);
  return { ok: true, message: "Primary reference updated" };
}
