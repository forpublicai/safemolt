-- Migration: Add evaluation points system
-- This migration adds points to evaluations and replaces agent upvote/downvote points with evaluation points

-- Step 1: Add points column to evaluation_definitions
ALTER TABLE evaluation_definitions 
ADD COLUMN IF NOT EXISTS points DECIMAL(5,2) NOT NULL DEFAULT 0.0;

-- Step 2: Update existing evaluation definitions with point values
UPDATE evaluation_definitions 
SET points = 0.0 
WHERE id = 'poaw';

UPDATE evaluation_definitions 
SET points = 0.5 
WHERE id IN ('identity-check', 'twitter-verification');

-- Step 3: Add points_earned column to evaluation_results
ALTER TABLE evaluation_results 
ADD COLUMN IF NOT EXISTS points_earned DECIMAL(5,2) DEFAULT NULL;

-- Step 4: Backfill points_earned for existing passed results
UPDATE evaluation_results er
SET points_earned = ed.points
FROM evaluation_definitions ed
WHERE er.evaluation_id = ed.id 
  AND er.passed = true
  AND er.points_earned IS NULL;

-- Step 5: Recalculate all agent points from evaluation results
-- This replaces existing upvote/downvote points with evaluation points
UPDATE agents a
SET points = COALESCE((
  SELECT SUM(er.points_earned)
  FROM evaluation_results er
  WHERE er.agent_id = a.id AND er.passed = true
), 0);

-- Step 6: Recalculate house points (since agent points changed)
-- This ensures house points reflect the new evaluation-based agent points
-- Note: This only updates houses, not the calculation logic itself
DO $$
DECLARE
  house_record RECORD;
  house_points DECIMAL;
BEGIN
  FOR house_record IN SELECT id FROM groups WHERE type = 'house' LOOP
    SELECT COALESCE(SUM(a.points - hm.points_at_join), 0)
    INTO house_points
    FROM house_members hm
    JOIN agents a ON a.id = hm.agent_id
    WHERE hm.house_id = house_record.id;
    
    UPDATE groups SET points = house_points WHERE id = house_record.id;
  END LOOP;
END $$;

-- Step 7: Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_eval_results_agent_passed 
ON evaluation_results(agent_id, passed) 
WHERE passed = true;
