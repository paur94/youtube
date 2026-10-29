CREATE TYPE "public"."asset_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."asset_source" AS ENUM('higgsfield_api', 'manual_import');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('pending_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."character_status" AS ENUM('draft', 'approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."job_mode" AS ENUM('api', 'manual');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('awaiting_manual', 'queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('planning', 'in_production', 'ready_for_assembly');--> statement-breakpoint
CREATE TYPE "public"."scene_status" AS ENUM('draft', 'ready', 'generating', 'review', 'failed', 'approved');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid,
	"character_id" uuid,
	"job_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"source" "asset_source" NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"status" "asset_status" DEFAULT 'pending_review' NOT NULL,
	"file_path" text,
	"original_name" text,
	"source_url" text,
	"content_type" text,
	"size_bytes" integer,
	"duration_seconds" numeric(8, 2),
	"prompt" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"replaces_id" uuid,
	"review_notes" text,
	"reviewed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"visual_description" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" character_status DEFAULT 'draft' NOT NULL,
	"primary_reference_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"mode" "job_mode" NOT NULL,
	"provider" text DEFAULT 'higgsfield' NOT NULL,
	"model" text,
	"output_kind" "asset_kind" NOT NULL,
	"status" "job_status" NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"request" jsonb,
	"external_request_id" text,
	"idempotency_key" uuid,
	"estimated_cost_usd" numeric(10, 4),
	"attempt" integer DEFAULT 1 NOT NULL,
	"retry_of_id" uuid,
	"error" text,
	"submitted_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"output_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid,
	"title" text NOT NULL,
	"visual_style" text DEFAULT '' NOT NULL,
	"status" "plan_status" DEFAULT 'planning' NOT NULL,
	"aspect_ratio" text DEFAULT '16:9' NOT NULL,
	"image_model" text NOT NULL,
	"video_model" text NOT NULL,
	"source_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"setting" text DEFAULT '' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"narration" text DEFAULT '' NOT NULL,
	"dialogue" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_seconds" integer NOT NULL,
	"visual_prompt" text DEFAULT '' NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"unmatched_characters" text[] DEFAULT '{}' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" "scene_status" DEFAULT 'ready' NOT NULL,
	"error" text,
	"selected_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_characters" (
	"scene_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	CONSTRAINT "scene_characters_scene_id_character_id_pk" PRIMARY KEY("scene_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "story_characters" (
	"story_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	CONSTRAINT "story_characters_story_id_character_id_pk" PRIMARY KEY("story_id","character_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_scene_id_production_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."production_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_replaces_id_assets_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_primary_reference_id_assets_id_fk" FOREIGN KEY ("primary_reference_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_scene_id_production_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."production_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_retry_of_id_generation_jobs_id_fk" FOREIGN KEY ("retry_of_id") REFERENCES "public"."generation_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_plans" ADD CONSTRAINT "production_plans_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_scenes" ADD CONSTRAINT "production_scenes_plan_id_production_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."production_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_scenes" ADD CONSTRAINT "production_scenes_selected_asset_id_assets_id_fk" FOREIGN KEY ("selected_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD CONSTRAINT "scene_characters_scene_id_production_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."production_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD CONSTRAINT "scene_characters_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_characters" ADD CONSTRAINT "story_characters_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_scene_id_index" ON "assets" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "assets_character_id_index" ON "assets" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "assets_status_index" ON "assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "assets_created_at_index" ON "assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "characters_status_index" ON "characters" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generation_jobs_scene_id_index" ON "generation_jobs" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_index" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "production_plans_story_id_index" ON "production_plans" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "production_plans_updated_at_index" ON "production_plans" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "production_scenes_plan_id_position_index" ON "production_scenes" USING btree ("plan_id","position");--> statement-breakpoint
CREATE INDEX "scene_characters_character_id_index" ON "scene_characters" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "story_characters_character_id_index" ON "story_characters" USING btree ("character_id");