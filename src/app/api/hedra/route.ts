import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { productionScenes } from "@/db/schema";
import { HEDRA_RESOLUTIONS } from "@/lib/hedra";
import { normalizeContentType } from "@/server/media/storage";
import { submitHedraGeneration } from "@/server/production/service";
import { sameOrigin } from "@/server/same-origin";

// Hedra Character 3 submissions carry the driving audio, so they go through a route handler:
// server actions cap request bodies at 1 MB.

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

const fieldsSchema = z.object({
  sceneId: z.uuid(),
  startAssetId: z.uuid({ error: "Choose a start image" }),
  resolution: z.enum(HEDRA_RESOLUTIONS),
});

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
  const file = form.get("audio");
  if (!(file instanceof File)) return json(false, "Choose an audio file");
  const fields = fieldsSchema.safeParse({
    sceneId: form.get("sceneId"),
    startAssetId: form.get("startAssetId"),
    resolution: form.get("resolution"),
  });
  if (!fields.success) return json(false, fields.error.issues[0].message);

  try {
    const [scene] = await db
      .select({ planId: productionScenes.planId })
      .from(productionScenes)
      .where(eq(productionScenes.id, fields.data.sceneId));
    if (!scene) return json(false, "Scene not found", 404);

    const result = await submitHedraGeneration({
      ...fields.data,
      audio: { bytes: new Uint8Array(await file.arrayBuffer()), contentType: normalizeContentType(file.type) },
    });
    revalidatePath("/production");
    revalidatePath(`/production/${scene.planId}`, "layout");
    return json(result.ok, result.message);
  } catch (error) {
    console.error("hedra: submit failed", error);
    return json(false, DB_ERROR, 503);
  }
}
