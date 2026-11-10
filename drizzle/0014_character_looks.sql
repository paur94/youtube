ALTER TABLE "characters" ADD COLUMN "looks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scene_characters" ADD COLUMN "look_id" text;