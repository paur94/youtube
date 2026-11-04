CREATE TYPE "public"."tiktok_post_state" AS ENUM('uploading', 'processing', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "tiktok_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"open_id" text NOT NULL,
	"username" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_token_expires_at" timestamp with time zone NOT NULL,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tiktok_connections_openId_unique" UNIQUE("open_id")
);
--> statement-breakpoint
CREATE TABLE "tiktok_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" uuid,
	"video_id" uuid,
	"state" "tiktok_post_state" DEFAULT 'uploading' NOT NULL,
	"open_id" text NOT NULL,
	"publish_id" text,
	"tiktok_status" text,
	"privacy_level" text NOT NULL,
	"caption" text NOT NULL,
	"post_id" text,
	"url" text,
	"error" text,
	"upload_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tiktok_posts" ADD CONSTRAINT "tiktok_posts_short_id_shorts_id_fk" FOREIGN KEY ("short_id") REFERENCES "public"."shorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tiktok_posts" ADD CONSTRAINT "tiktok_posts_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_posts_short_id_index" ON "tiktok_posts" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tiktok_posts_video_id_index" ON "tiktok_posts" USING btree ("video_id");