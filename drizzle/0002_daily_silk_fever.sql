CREATE TYPE "public"."revision_source" AS ENUM('generated', 'regenerated', 'edited', 'restored');--> statement-breakpoint
CREATE TYPE "public"."story_status" AS ENUM('draft', 'review', 'approved');--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid,
	"title" text NOT NULL,
	"age_group" "age_group" NOT NULL,
	"topic" text NOT NULL,
	"learning_objective" text NOT NULL,
	"characters" text DEFAULT '' NOT NULL,
	"target_duration_seconds" integer NOT NULL,
	"tone" text NOT NULL,
	"visual_style" text NOT NULL,
	"language" text DEFAULT 'English' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" "story_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
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
CREATE TABLE "story_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"source" "revision_source" NOT NULL,
	"content" jsonb NOT NULL,
	"generation_id" uuid,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_generations" ADD CONSTRAINT "story_generations_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revisions" ADD CONSTRAINT "story_revisions_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revisions" ADD CONSTRAINT "story_revisions_generation_id_story_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."story_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_status_index" ON "stories" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stories_updated_at_index" ON "stories" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "stories_idea_id_index" ON "stories" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "story_generations_story_id_index" ON "story_generations" USING btree ("story_id");--> statement-breakpoint
CREATE UNIQUE INDEX "story_revisions_story_id_number_index" ON "story_revisions" USING btree ("story_id","number");