ALTER TABLE "ideas" ADD COLUMN "learning_objective" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Plan readiness is now automatic: mark plans whose scenes are all approved.
UPDATE "production_plans" p SET "status" = 'ready_for_assembly'
WHERE p."status" <> 'ready_for_assembly'
  AND EXISTS (SELECT 1 FROM "production_scenes" s WHERE s."plan_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "production_scenes" s WHERE s."plan_id" = p."id" AND s."status" <> 'approved');
--> statement-breakpoint
-- Idea status now follows the pipeline (forward only, archived ideas untouched).
UPDATE "ideas" SET "status" = 'generated'
WHERE "status" IN ('draft', 'approved', 'scripted')
  AND "id" IN (SELECT st."idea_id" FROM "stories" st JOIN "production_plans" p ON p."story_id" = st."id" WHERE p."status" = 'ready_for_assembly');
--> statement-breakpoint
UPDATE "ideas" SET "status" = 'published'
WHERE "status" IN ('draft', 'approved', 'scripted', 'generated')
  AND "id" IN (
    SELECT st."idea_id" FROM "stories" st
    WHERE EXISTS (SELECT 1 FROM "shorts" sh WHERE sh."story_id" = st."id" AND sh."status" = 'published')
       OR EXISTS (SELECT 1 FROM "videos" v WHERE v."story_id" = st."id" AND v."status" = 'published')
  );
