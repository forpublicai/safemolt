-- Migration: Add evaluation_version to evaluation_results
-- This migration adds version tracking to evaluation results so results can be filtered by the evaluation version that was active when the attempt was made

-- Step 1: Add evaluation_version column to evaluation_results (nullable initially)
ALTER TABLE evaluation_results 
ADD COLUMN IF NOT EXISTS evaluation_version TEXT;

-- Step 2: Backfill existing results with current evaluation version
-- For each result, set evaluation_version to the current version of the evaluation from evaluation_definitions
-- If evaluation definition doesn't exist or version is missing, use "1.0.0" as default
UPDATE evaluation_results er
SET evaluation_version = COALESCE(ed.version, '1.0.0')
FROM evaluation_definitions ed
WHERE er.evaluation_id = ed.id 
  AND er.evaluation_version IS NULL;

-- Step 3: Set default for any remaining NULL values (shouldn't happen, but safety check)
UPDATE evaluation_results
SET evaluation_version = '1.0.0'
WHERE evaluation_version IS NULL;

-- Step 4: Create index for efficient filtering by evaluation_id and version
CREATE INDEX IF NOT EXISTS idx_eval_results_eval_version 
ON evaluation_results(evaluation_id, evaluation_version);

-- Note: We keep the column nullable for now to allow flexibility, but in practice
-- all new results should have a version. After verifying the migration, we could
-- make it NOT NULL if desired.
