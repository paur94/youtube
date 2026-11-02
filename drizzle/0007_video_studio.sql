CREATE TYPE "public"."video_status" AS ENUM('draft', 'ready_for_review', 'approved', 'rejected', 'scheduled', 'published', 'failed');--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid,
	"story_id" uuid,
	"status" "video_status" DEFAULT 'draft' NOT NULL,
	"clips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"edit_settings" jsonb NOT NULL,
	"captions_reviewed" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}' NOT NULL,
	"playlist" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"metadata_approved_at" timestamp with time zone,
	"render_file_path" text,
	"render_key" text,
	"rendered_at" timestamp with time zone,
	"render_error" text,
	"render_started_at" timestamp with time zone,
	"render_progress" real,
	"output_probe" jsonb,
	"output_audio" jsonb,
	"review_notes" text,
	"reviewed_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"youtube_url" text,
	"youtube_video_id" text,
	"upload_started_at" timestamp with time zone,
	"publish_error" text,
	"publish_failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_plan_id_production_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."production_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "videos_status_index" ON "videos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "videos_plan_id_index" ON "videos" USING btree ("plan_id");