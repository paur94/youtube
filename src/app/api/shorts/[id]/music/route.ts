import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { shorts } from "@/db/schema";
import { checkMusicFile, isShortLocked, MUSIC_TYPES } from "@/lib/shorts";
import { FfmpegError, getFfmpegVersion, probeMedia } from "@/server/media/ffmpeg";
import { normalizeContentType, resolveMediaPath, saveInputFile } from "@/server/media/storage";
import { sameOrigin } from "@/server/same-origin";

// Background music for a Short. Uploads go through a route handler: server actions cap request
// bodies at 1 MB.

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";

function json(ok: boolean, message: string, status = ok ? 200 : 400) {
  return Response.json({ ok, message }, { status });
}

/** Some browsers send no type for .m4a or .ogg files: fall back to the extension. */
function musicType(file: File) {
  const type = normalizeContentType(file.type);
  if (MUSIC_TYPES[type]) return type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return Object.entries(MUSIC_TYPES).find(([, e]) => e === ext)?.[0] ?? type;
}

export async function POST(request: Request, ctx: RouteContext<"/api/shorts/[id]/music">) {
  if (!sameOrigin(request)) return json(false, "Cross-origin uploads are not allowed", 403);
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return json(false, "Short not found", 404);
  if (!(await getFfmpegVersion())) return json(false, "FFmpeg isn't installed, so music can't be checked or mixed");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(false, "Could not read the upload");
  }
  const file = form.get("music");
  if (!(file instanceof File)) return json(false, "Choose an audio file");
  const contentType = musicType(file);
  const problem = checkMusicFile(contentType, file.size);
  if (problem) return json(false, problem);

  try {
    const [short] = await db.select().from(shorts).where(eq(shorts.id, id));
    if (!short) return json(false, "Short not found", 404);
    if (isShortLocked(short)) return json(false, "Published or uploaded Shorts are locked. Mark it as not published on the Publishing page first to edit it.");

    const filePath = await saveInputFile(new Uint8Array(await file.arrayBuffer()), MUSIC_TYPES[contentType], `shorts/${short.id}/music`);
    const probe = await probeMedia(filePath).catch(() => null);
    if (!probe?.hasAudio || !probe.durationSeconds) {
      const full = resolveMediaPath(filePath);
      if (full) await rm(full, { force: true });
      return json(false, "That file has no readable audio");
    }

    const name = file.name.slice(0, 200) || "music";
    await db
      .update(shorts)
      .set({
        videoSettings: { ...short.videoSettings, music: { filePath, name } },
        ...(short.status === "draft" || short.status === "rejected" ? {} : { status: "draft" as const, scheduledAt: null, publishError: null }),
      })
      .where(eq(shorts.id, short.id));
    revalidatePath("/shorts");
    revalidatePath("/publishing");
    revalidatePath(`/shorts/${short.id}`);
    return json(true, `Music added (${Math.round(probe.durationSeconds)} s). Render again to hear it.`);
  } catch (error) {
    if (error instanceof FfmpegError) return json(false, error.message);
    console.error("shorts: music upload failed", error);
    return json(false, DB_ERROR, 503);
  }
}
