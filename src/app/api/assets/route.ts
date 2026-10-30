import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { characters, productionScenes } from "@/db/schema";
import { MediaError, saveMedia } from "@/server/media/storage";
import { addAsset } from "@/server/production/service";
import { sameOrigin } from "@/server/same-origin";

// File uploads go through a route handler because server actions cap request bodies at 1 MB.
// No auth yet: like the server actions, this only accepts same-origin requests and the app
// must stay on localhost.

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

const fieldsSchema = z
  .object({
    sceneId: z.uuid().nullish(),
    characterId: z.uuid().nullish(),
    jobId: z.uuid().nullish(),
    replacesId: z.uuid().nullish(),
    model: z.string().trim().max(120).nullish(),
    durationSeconds: z.coerce.number().positive().max(3600).nullish(),
  })
  .refine((f) => Boolean(f.sceneId) !== Boolean(f.characterId), "Upload to either a scene or a character");

function json(ok: boolean, message: string, status = ok ? 200 : 400) {
  return Response.json({ ok, message }, { status });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json(false, "Cross-origin uploads are not allowed", 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(false, "Could not read the upload");
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json(false, "Choose a file to upload");

  const value = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const fields = fieldsSchema.safeParse({
    sceneId: value("sceneId"),
    characterId: value("characterId"),
    jobId: value("jobId"),
    replacesId: value("replacesId"),
    model: value("model"),
    durationSeconds: value("durationSeconds"),
  });
  if (!fields.success) return json(false, fields.error.issues[0].message);
  const { sceneId, characterId, jobId, replacesId, model, durationSeconds } = fields.data;

  let planId: string | null = null;
  try {
    if (sceneId) {
      const [scene] = await db
        .select({ planId: productionScenes.planId })
        .from(productionScenes)
        .where(eq(productionScenes.id, sceneId));
      if (!scene) return json(false, "Scene not found", 404);
      planId = scene.planId;
    } else {
      const [character] = await db.select({ id: characters.id }).from(characters).where(eq(characters.id, characterId!));
      if (!character) return json(false, "Character not found", 404);
    }
  } catch (error) {
    console.error("upload: lookup failed", error);
    return json(false, DB_ERROR, 503);
  }

  let saved: Awaited<ReturnType<typeof saveMedia>>;
  try {
    saved = await saveMedia(
      new Uint8Array(await file.arrayBuffer()),
      file.type,
      sceneId ? `scenes/${sceneId}` : `characters/${characterId}`,
    );
  } catch (error) {
    return json(false, error instanceof MediaError ? error.message : "Could not store the file");
  }
  if (characterId && saved.kind !== "image") return json(false, "Character references must be images");

  try {
    await db.transaction((tx) =>
      addAsset(tx, {
        sceneId,
        characterId,
        jobId,
        replacesId,
        kind: saved.kind,
        source: "manual_import",
        provider: sceneId ? "Higgsfield (manual)" : "Upload",
        model,
        filePath: saved.filePath,
        originalName: file.name.slice(0, 200),
        contentType: saved.contentType,
        sizeBytes: saved.sizeBytes,
        durationSeconds: saved.kind === "video" ? durationSeconds : null,
      }),
    );
  } catch (error) {
    console.error("upload: save failed", error);
    return json(false, DB_ERROR, 503);
  }

  revalidatePath("/production/assets");
  if (planId) revalidatePath(`/production/${planId}`, "layout");
  if (characterId) {
    revalidatePath("/characters");
    revalidatePath(`/characters/${characterId}`);
  }
  return json(true, sceneId ? "Imported. Review it before using it as the final asset." : "Reference image added. Approve it to reuse it.");
}
