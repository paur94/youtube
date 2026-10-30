CREATE TYPE "public"."short_status" AS ENUM('draft', 'approved', 'rejected', 'scheduled', 'published');--> statement-breakpoint
CREATE TABLE "short_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" uuid,
	"plan_id" uuid,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"duration_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"views" integer,
	"average_view_duration_seconds" real,
	"viewed_percent" real,
	"average_percentage_viewed" real,
	"likes" integer,
	"subscribers_gained" integer,
	"traffic_sources" jsonb,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid,
	"plan_id" uuid,
	"story_id" uuid,
	"source_asset_id" uuid,
	"scene_title" text NOT NULL,
	"scene_number" integer NOT NULL,
	"source_file_path" text,
	"source_probe" jsonb,
	"status" "short_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}' NOT NULL,
	"playlist" text DEFAULT '' NOT NULL,
	"hook" text DEFAULT '' NOT NULL,
	"hook_seconds" real DEFAULT 2.5 NOT NULL,
	"publish_order" integer,
	"publish_order_reason" text,
	"metadata_approved_at" timestamp with time zone,
	"captions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captions_reviewed" boolean DEFAULT false NOT NULL,
	"video_settings" jsonb NOT NULL,
	"analysis" jsonb,
	"analyzed_at" timestamp with time zone,
	"render_file_path" text,
	"render_key" text,
	"rendered_at" timestamp with time zone,
	"render_error" text,
	"output_probe" jsonb,
	"output_audio" jsonb,
	"review_notes" text,
	"reviewed_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"youtube_url" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "short_generations" ADD CONSTRAINT "short_generations_short_id_shorts_id_fk" FOREIGN KEY ("short_id") REFERENCES "public"."shorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_generations" ADD CONSTRAINT "short_generations_plan_id_production_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."production_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_metrics" ADD CONSTRAINT "short_metrics_short_id_shorts_id_fk" FOREIGN KEY ("short_id") REFERENCES "public"."shorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shorts" ADD CONSTRAINT "shorts_scene_id_production_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."production_scenes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shorts" ADD CONSTRAINT "shorts_plan_id_production_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."production_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shorts" ADD CONSTRAINT "shorts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shorts" ADD CONSTRAINT "shorts_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "short_generations_short_id_index" ON "short_generations" USING btree ("short_id");--> statement-breakpoint
CREATE INDEX "short_metrics_short_id_captured_at_index" ON "short_metrics" USING btree ("short_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shorts_scene_id_index" ON "shorts" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "shorts_status_index" ON "shorts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shorts_plan_id_index" ON "shorts" USING btree ("plan_id");