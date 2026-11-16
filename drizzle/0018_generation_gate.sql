ALTER TABLE "lab_jobs" ADD COLUMN "qc" jsonb;--> statement-breakpoint
ALTER TABLE "lab_projects" ADD COLUMN "qc" jsonb DEFAULT '{"scenes":{}}'::jsonb NOT NULL;