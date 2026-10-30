ALTER TYPE "public"."short_status" ADD VALUE 'ready_for_review' BEFORE 'approved';--> statement-breakpoint
ALTER TYPE "public"."short_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "youtube_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"channel_title" text NOT NULL,
	"channel_handle" text,
	"thumbnail_url" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"refresh_token" text NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "youtube_connections_channelId_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
ALTER TABLE "shorts" ADD COLUMN "youtube_video_id" text;--> statement-breakpoint
ALTER TABLE "shorts" ADD COLUMN "upload_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shorts" ADD COLUMN "publish_error" text;--> statement-breakpoint
ALTER TABLE "shorts" ADD COLUMN "publish_failed_at" timestamp with time zone;