"use server";

import { readFile } from "node:fs/promises";

import { and, eq, inArray, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/db";
import { tiktokPosts } from "@/db/schema";
import { QUEUE_STATUSES } from "@/lib/shorts";
import { buildTikTokCaption, TIKTOK_CAPTION_MAX, TIKTOK_PRIVACY_LEVELS, type TikTokPrivacyLevel, tikTokPostUrl } from "@/lib/tiktok";
import { resolveMediaPath } from "@/server/media/storage";
import { describeTikTokFailReason, getTikTokConfig, type TikTokCreatorInfo, TikTokError } from "@/server/providers/tiktok";
import { consistencyPublishBlocker, shortConsistency, videoConsistency } from "@/server/qc/service";
import { getShortPublishContext, isRenderCurrent } from "@/server/queries/shorts";
import { getVideoPublishContext, isVideoRenderCurrent } from "@/server/queries/videos";
import { deleteTikTokConnection, getTikTokClient, getTikTokConnection } from "@/server/tiktok/connection";

import type { ActionResult } from "./ideas";

// No auth yet: this app only runs locally. Add an auth check before deploying it anywhere reachable.
// Nothing is posted automatically: publishToTikTok runs only when the user fills in TikTok's post
// form, ticks the consent box and clicks Post, and only for a Short or video they approved.

const DB_ERROR = "Could not reach the database. Is Postgres running (npm run db:up)?";
const NOT_APPROVED = "Only approved Shorts and videos can be posted. Approve it in the studio first.";

const kindSchema = z.enum(["short", "video"]);
type Kind = z.infer<typeof kindSchema>;
const idSchema = z.uuid();

/** An upload that started this long ago without finishing is treated as abandoned. */
const UPLOAD_LOCK_MS = 2 * 60 * 60_000;

function revalidate(kind: Kind, id: string) {
  revalidatePath("/publishing");
  revalidatePath(kind === "short" ? `/shorts/${id}` : `/videos/${id}`);
}

function failure(error: unknown, where: string): { ok: false; message: string } {
  if (error instanceof TikTokError) return { ok: false, message: error.message };
  console.error(`${where} failed`, error);
  return { ok: false, message: DB_ERROR };
}

const postKey = (kind: Kind, id: string) => (kind === "short" ? eq(tiktokPosts.shortId, id) : eq(tiktokPosts.videoId, id));

async function loadPost(kind: Kind, id: string) {
  const [row] = await db.select().from(tiktokPosts).where(postKey(kind, id));
  return row ?? null;
}

/** The approved item, normalized across Shorts and videos, or a reason it can't be posted. */
async function loadPostable(kind: Kind, id: string) {
  if (kind === "short") {
    const context = await getShortPublishContext(id);
    if (!context) return { error: "Short not found" } as const;
    const { short } = context;
    if (!QUEUE_STATUSES.includes(short.status) || !short.reviewedAt) return { error: NOT_APPROVED } as const;
    if (!short.metadataApprovedAt) return { error: "Approve the metadata first" } as const;
    if (!short.renderFilePath || !isRenderCurrent(short)) return { error: "The vertical render is missing or out of date. Re-render it." } as const;
    return {
      item: {
        title: short.title,
        description: short.description,
        hashtags: short.hashtags,
        renderFilePath: short.renderFilePath,
        durationSeconds: short.outputProbe?.durationSeconds ?? null,
        containsSyntheticMedia: context.containsSyntheticMedia ?? true,
        storyBlocker: async () => consistencyPublishBlocker(await shortConsistency(short)),
      },
    } as const;
  }
  const context = await getVideoPublishContext(id);
  if (!context) return { error: "Video not found" } as const;
  const { video } = context;
  if (!QUEUE_STATUSES.includes(video.status) || !video.reviewedAt) return { error: NOT_APPROVED } as const;
  if (!video.metadataApprovedAt) return { error: "Approve the metadata first" } as const;
  if (!video.renderFilePath || !isVideoRenderCurrent(video)) return { error: "The render is missing or out of date. Render it again." } as const;
  return {
    item: {
      title: video.title,
      description: video.description,
      hashtags: video.hashtags,
      renderFilePath: video.renderFilePath,
      durationSeconds: video.outputProbe?.durationSeconds ?? null,
      containsSyntheticMedia: context.containsSyntheticMedia ?? true,
      storyBlocker: async () => consistencyPublishBlocker(await videoConsistency(video)),
    },
  } as const;
}

function durationBlocker(durationSeconds: number | null, creator: TikTokCreatorInfo) {
  if (durationSeconds === null || creator.maxDurationSeconds === null) return null;
  if (durationSeconds <= creator.maxDurationSeconds) return null;
  return `This account can post up to ${Math.floor(creator.maxDurationSeconds / 60)} min ${creator.maxDurationSeconds % 60} s through the API, and this one is ${Math.round(durationSeconds)} s.`;
}

export async function disconnectTikTok(): Promise<ActionResult> {
  try {
    const removed = await deleteTikTokConnection();
    revalidatePath("/settings");
    revalidatePath("/publishing");
    return removed ? { ok: true, message: "TikTok account disconnected and access revoked" } : { ok: false, message: "No account is connected" };
  } catch (error) {
    console.error("disconnectTikTok failed", error);
    return { ok: false, message: DB_ERROR };
  }
}

export type TikTokPostForm = {
  creator: TikTokCreatorInfo;
  caption: string;
  isAigc: boolean;
  durationSeconds: number | null;
  /** Set when the item can't be posted right now; the dialog shows it instead of the form. */
  blocker: string | null;
};

/**
 * What the "Post to TikTok" dialog needs. TikTok requires reading the creator info afresh every
 * time the post form opens, so this runs on each open.
 */
export async function getTikTokPostForm(kind: string, id: string): Promise<{ ok: true; form: TikTokPostForm } | { ok: false; message: string }> {
  const k = kindSchema.safeParse(kind);
  const itemId = idSchema.safeParse(id);
  if (!k.success || !itemId.success) return { ok: false, message: "Invalid id" };
  if (!getTikTokConfig().configured) return { ok: false, message: "TikTok isn't configured. See Settings." };
  try {
    const loaded = await loadPostable(k.data, itemId.data);
    if ("error" in loaded) return { ok: false, message: loaded.error! };
    const existing = await loadPost(k.data, itemId.data);
    if (existing?.state === "uploading" && existing.uploadStartedAt.getTime() > Date.now() - UPLOAD_LOCK_MS) {
      return { ok: false, message: "An upload to TikTok is already running. Reload the page in a few minutes." };
    }
    if (existing?.state === "processing" || existing?.state === "published") {
      return { ok: false, message: "This is already posted to TikTok. Use “Check TikTok” or “Forget TikTok post”." };
    }
    const { client } = await getTikTokClient();
    const creator = await client.getCreatorInfo();
    const { item } = loaded;
    return {
      ok: true,
      form: {
        creator,
        caption: buildTikTokCaption(item),
        isAigc: item.containsSyntheticMedia,
        durationSeconds: item.durationSeconds,
        blocker: durationBlocker(item.durationSeconds, creator) ?? (await item.storyBlocker()),
      },
    };
  } catch (error) {
    return failure(error, "getTikTokPostForm");
  }
}

const publishSchema = z
  .object({
    kind: kindSchema,
    id: idSchema,
    caption: z.string().trim().refine((s) => [...s].length <= TIKTOK_CAPTION_MAX, `TikTok captions are limited to ${TIKTOK_CAPTION_MAX} characters`),
    privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS, "Choose who can view this post"),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    disclose: z.boolean(),
    yourBrand: z.boolean(),
    brandedContent: z.boolean(),
    isAigc: z.boolean(),
    // The literal `true` from the consent checkbox: nothing is sent to TikTok without it.
    confirmed: z.literal(true, "Confirm the post in the dialog first"),
  })
  .refine((v) => !v.disclose || v.yourBrand || v.brandedContent, "You need to indicate if your content promotes yourself, a third party, or both.")
  .refine((v) => !(v.disclose && v.brandedContent && v.privacyLevel === "SELF_ONLY"), "Branded content visibility cannot be set to private.");

export type TikTokPublishInput = z.input<typeof publishSchema>;

/** Posts an approved Short or video to the connected TikTok account with the settings the user chose. */
export async function publishToTikTok(input: TikTokPublishInput): Promise<ActionResult> {
  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
  const p = parsed.data;
  if (!getTikTokConfig().configured) return { ok: false, message: "TikTok isn't configured. See Settings." };

  let claimedId: string | null = null;
  try {
    const loaded = await loadPostable(p.kind, p.id);
    if ("error" in loaded) return { ok: false, message: loaded.error! };
    const { item } = loaded;
    const storyBlocker = await item.storyBlocker();
    if (storyBlocker) return { ok: false, message: storyBlocker };
    const file = resolveMediaPath(item.renderFilePath);
    if (!file) return { ok: false, message: "The rendered file isn't in the media folder" };
    if (!(await getTikTokConnection())) return { ok: false, message: "Connect a TikTok account in Settings first" };

    // Check the choices against the account as it is right now.
    const { client, openId } = await getTikTokClient();
    const creator = await client.getCreatorInfo();
    if (!creator.privacyLevelOptions.includes(p.privacyLevel)) {
      return { ok: false, message: "That visibility isn't available for this account any more. Reopen the dialog and choose again." };
    }
    const tooLong = durationBlocker(item.durationSeconds, creator);
    if (tooLong) return { ok: false, message: tooLong };

    // Claim the item so a double click or a second tab can't post it twice.
    const existing = await loadPost(p.kind, p.id);
    const values = {
      state: "uploading" as const,
      openId,
      privacyLevel: p.privacyLevel,
      caption: p.caption,
      publishId: null,
      tiktokStatus: null,
      postId: null,
      url: null,
      error: null,
      uploadStartedAt: new Date(),
      publishedAt: null,
    };
    let claim: { id: string }[];
    if (!existing) {
      claim = await db
        .insert(tiktokPosts)
        .values({ ...values, ...(p.kind === "short" ? { shortId: p.id } : { videoId: p.id }) })
        .onConflictDoNothing()
        .returning({ id: tiktokPosts.id });
    } else {
      claim = await db
        .update(tiktokPosts)
        .set(values)
        .where(
          and(
            eq(tiktokPosts.id, existing.id),
            or(
              eq(tiktokPosts.state, "failed"),
              and(eq(tiktokPosts.state, "uploading"), lt(tiktokPosts.uploadStartedAt, new Date(Date.now() - UPLOAD_LOCK_MS))),
            ),
          ),
        )
        .returning({ id: tiktokPosts.id });
    }
    if (!claim.length) return { ok: false, message: "This is already being posted or is on TikTok. Reload the page." };
    claimedId = claim[0].id;

    let publishId: string;
    try {
      const bytes = await readFile(file);
      ({ publishId } = await client.postVideo({
        postInfo: {
          title: p.caption,
          privacyLevel: p.privacyLevel as TikTokPrivacyLevel,
          // TikTok forces these off when the creator disabled them in the app.
          disableComment: !p.allowComment || creator.commentDisabled,
          disableDuet: !p.allowDuet || creator.duetDisabled,
          disableStitch: !p.allowStitch || creator.stitchDisabled,
          brandContent: p.disclose && p.brandedContent,
          brandOrganic: p.disclose && p.yourBrand,
          isAigc: p.isAigc,
        },
        bytes,
        contentType: "video/mp4",
      }));
    } catch (error) {
      const known = error instanceof TikTokError;
      let message = known ? error.message : "The upload failed unexpectedly";
      // A lost response after the last chunk arrived may still have created the post.
      if (!known || error.status === null || error.status >= 500) message += " Check the TikTok app before retrying, in case it went through.";
      console.error("publishToTikTok upload failed", error);
      await db.update(tiktokPosts).set({ state: "failed", error: message }).where(eq(tiktokPosts.id, claimedId));
      claimedId = null;
      revalidate(p.kind, p.id);
      return { ok: false, message };
    }

    try {
      await db.update(tiktokPosts).set({ state: "processing", publishId, tiktokStatus: "PROCESSING_UPLOAD" }).where(eq(tiktokPosts.id, claimedId));
    } catch (error) {
      console.error(`publishToTikTok: sent post ${publishId} but couldn't record it`, error);
      return { ok: false, message: `Sent to TikTok (publish id ${publishId}), but saving that here failed. Don't post it again: check the TikTok app.` };
    }
    claimedId = null;
    revalidate(p.kind, p.id);
    return { ok: true, message: "Sent to TikTok. Processing can take a few minutes before it appears on the profile; use “Check TikTok” to follow it." };
  } catch (error) {
    return failure(error, "publishToTikTok");
  } finally {
    if (claimedId) await db.update(tiktokPosts).set({ state: "failed", error: "The post was interrupted. Retry." }).where(eq(tiktokPosts.id, claimedId)).catch(() => undefined);
  }
}

/** Reads the post's status from TikTok and records when it went live or failed. */
export async function refreshTikTokStatus(kind: string, id: string): Promise<ActionResult> {
  const k = kindSchema.safeParse(kind);
  const itemId = idSchema.safeParse(id);
  if (!k.success || !itemId.success) return { ok: false, message: "Invalid id" };
  try {
    const post = await loadPost(k.data, itemId.data);
    if (!post?.publishId) return { ok: false, message: "This wasn't posted to TikTok by this app" };
    const { client } = await getTikTokClient();
    const remote = await client.getPostStatus(post.publishId);
    if (remote.status === "FAILED") {
      const message = describeTikTokFailReason(remote.failReason ?? undefined);
      await db.update(tiktokPosts).set({ state: "failed", tiktokStatus: remote.status, error: message }).where(eq(tiktokPosts.id, post.id));
      revalidate(k.data, itemId.data);
      return { ok: false, message };
    }
    if (remote.status === "PUBLISH_COMPLETE") {
      const connection = await getTikTokConnection();
      const postId = remote.postId ?? post.postId;
      await db
        .update(tiktokPosts)
        .set({
          state: "published",
          tiktokStatus: remote.status,
          postId,
          url: tikTokPostUrl(connection?.openId === post.openId ? connection.username : null, postId),
          publishedAt: post.publishedAt ?? new Date(),
          error: null,
        })
        .where(eq(tiktokPosts.id, post.id));
      revalidate(k.data, itemId.data);
      return {
        ok: true,
        message: postId
          ? "It's live on TikTok"
          : "Posted. TikTok shows a link only for public posts that passed moderation; check again later, or the post is private.",
      };
    }
    await db.update(tiktokPosts).set({ tiktokStatus: remote.status }).where(eq(tiktokPosts.id, post.id));
    revalidate(k.data, itemId.data);
    return { ok: true, message: "TikTok is still processing the post. Check again in a minute." };
  } catch (error) {
    return failure(error, "refreshTikTokStatus");
  }
}

/** Forgets this app's record of a TikTok post. The post itself stays on TikTok until it is deleted in the app. */
export async function forgetTikTokPost(kind: string, id: string): Promise<ActionResult> {
  const k = kindSchema.safeParse(kind);
  const itemId = idSchema.safeParse(id);
  if (!k.success || !itemId.success) return { ok: false, message: "Invalid id" };
  try {
    const removed = await db
      .delete(tiktokPosts)
      .where(and(postKey(k.data, itemId.data), inArray(tiktokPosts.state, ["processing", "published", "failed"])))
      .returning({ id: tiktokPosts.id });
    if (!removed.length) return { ok: false, message: "Nothing to forget, or an upload is still running" };
    revalidate(k.data, itemId.data);
    return { ok: true, message: "TikTok post forgotten here. It stays on TikTok until you delete it in the app." };
  } catch (error) {
    return failure(error, "forgetTikTokPost");
  }
}
