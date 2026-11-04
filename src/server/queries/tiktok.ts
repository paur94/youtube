import "server-only";

import { db } from "@/db";
import { type TikTokPost, tiktokPosts } from "@/db/schema";

/** Every TikTok post, keyed by the Short's or video's id. */
export async function getTikTokPosts() {
  const rows = await db.select().from(tiktokPosts);
  const byId = new Map<string, TikTokPost>();
  for (const row of rows) {
    const id = row.shortId ?? row.videoId;
    if (id) byId.set(id, row);
  }
  return byId;
}
