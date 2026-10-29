CREATE TYPE "public"."idea_category" AS ENUM('songs', 'stories', 'learning', 'animals', 'adventure', 'bedtime', 'seasonal', 'other');--> statement-breakpoint
CREATE TYPE "public"."originality_status" AS ENUM('not_reviewed', 'in_review', 'original', 'needs_changes');--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "category" "idea_category" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "originality_status" "originality_status" DEFAULT 'not_reviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;