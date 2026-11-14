CREATE TABLE "lab_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scene_id" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"prompt" text NOT NULL,
	"request" jsonb,
	"external_request_id" text,
	"estimated_cost_usd" numeric(10, 4),
	"error" text,
	"file_path" text,
	"content_type" text,
	"source_url" text,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"aspect_ratio" text DEFAULT '16:9' NOT NULL,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"story" jsonb,
	"story_version" integer DEFAULT 0 NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_jobs" ADD CONSTRAINT "lab_jobs_project_id_lab_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."lab_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_jobs_project_id_index" ON "lab_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "lab_jobs_status_index" ON "lab_jobs" USING btree ("status");