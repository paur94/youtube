CREATE TYPE "public"."age_group" AS ENUM('0-2', '3-5', '6-8', '9-12');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('draft', 'approved', 'scripted', 'generated', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."video_format" AS ENUM('short', 'standard', 'long');--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "idea_status" DEFAULT 'draft' NOT NULL,
	"age_group" "age_group" DEFAULT '3-5' NOT NULL,
	"format" "video_format" DEFAULT 'standard' NOT NULL,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"made_for_kids" boolean DEFAULT true NOT NULL,
	"contains_synthetic_media" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ideas_status_index" ON "ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ideas_created_at_index" ON "ideas" USING btree ("created_at");