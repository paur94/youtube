"use server";

import { revalidatePath } from "next/cache";

import { deleteYouTubeConnection } from "@/server/youtube/connection";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check before deploying it anywhere reachable.

export async function disconnectYouTube(): Promise<ActionResult> {
  try {
    const removed = await deleteYouTubeConnection();
    revalidatePath("/settings");
    revalidatePath("/publishing");
    return removed ? { ok: true, message: "YouTube channel disconnected and access revoked" } : { ok: false, message: "No channel is connected" };
  } catch (error) {
    console.error("disconnectYouTube failed", error);
    return { ok: false, message: "Could not reach the database. Is Postgres running (npm run db:up)?" };
  }
}
