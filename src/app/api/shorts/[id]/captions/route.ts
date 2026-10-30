import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { shorts } from "@/db/schema";
import { toSrt } from "@/lib/shorts";

// SubRip caption track for uploading to YouTube alongside (or instead of) burned-in captions.
export async function GET(_request: Request, ctx: RouteContext<"/api/shorts/[id]/captions">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [short] = await db.select({ captions: shorts.captions, sceneNumber: shorts.sceneNumber }).from(shorts).where(eq(shorts.id, id));
  if (!short) return new Response("Not found", { status: 404 });
  return new Response(toSrt(short.captions), {
    headers: {
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition": `attachment; filename="short-scene-${short.sceneNumber}.srt"`,
      "Cache-Control": "no-store",
    },
  });
}
