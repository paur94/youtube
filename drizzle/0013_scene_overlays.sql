ALTER TABLE "production_plans" ADD COLUMN "clip_music" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "production_scenes" ADD COLUMN "overlays" jsonb DEFAULT '[]'::jsonb NOT NULL;