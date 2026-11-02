import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { videos } from "@/db/schema";
import { computeTimeline, timelineCaptions } from "@/lib/long-video";
import { toSrt } from "@/lib/shorts";

// SubRip caption track for the whole video, timed against the edited timeline.
export async function GET(_request: Request, ctx: RouteContext<"/api/videos/[id]/captions">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new Response("Not found", { status: 404 });
  const [video] = await db.select({ clips: videos.clips, editSettings: videos.editSettings }).from(videos).where(eq(videos.id, id));
  if (!video) return new Response("Not found", { status: 404 });
  const cues = timelineCaptions(video.clips, computeTimeline(video.clips, video.editSettings));
  return new Response(toSrt(cues), {
    headers: {
      "Content-Type": "application/x-subrip; charset=utf-8",
      "Content-Disposition": `attachment; filename="video-${id.slice(0, 8)}.srt"`,
      "Cache-Control": "no-store",
    },
  });
}
