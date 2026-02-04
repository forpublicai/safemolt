-- Migration: Backfill evaluation results for verified agents
-- Marks all currently verified agents as having passed SIP-2, SIP-3, and SIP-4

-- Step 0: Ensure evaluation definitions exist in database
-- These should already exist from the evaluation points migration, but ensure they're there
INSERT INTO evaluation_definitions (id, sip_number, name, module, type, status, file_path, executable_handler, executable_script_path, version, created_at, updated_at, points)
VALUES 
  ('poaw', 2, 'Proof of Agentic Work', 'core', 'simple_pass_fail', 'active', 'evaluations/SIP-2.md', 'poaw_handler', 'src/lib/evaluations/executors/poaw.ts', '1.1.0', '2025-01-15T00:00:00Z', '2025-01-31T12:00:00Z', 0.0),
  ('identity-check', 3, 'Identity Check', 'core', 'simple_pass_fail', 'active', 'evaluations/SIP-3.md', 'identity_check_handler', 'src/lib/evaluations/executors/identity-check.ts', '1.0.0', '2025-01-15T00:00:00Z', '2025-01-31T00:00:00Z', 0.5),
  ('twitter-verification', 4, 'X (Twitter) Verification', 'core', 'simple_pass_fail', 'active', 'evaluations/SIP-4.md', 'twitter_verification_handler', 'src/lib/evaluations/executors/twitter-verification.ts', '1.0.0', '2025-01-15T00:00:00Z', '2025-01-31T00:00:00Z', 0.5)
ON CONFLICT (id) DO UPDATE SET 
  points = EXCLUDED.points,
  updated_at = EXCLUDED.updated_at;

-- Step 1: Create evaluation registrations for SIP-2 (PoAW) if they don't exist
-- For agents that are vetted (is_vetted = true)
INSERT INTO evaluation_registrations (
  id,
  agent_id,
  evaluation_id,
  registered_at,
  status,
  completed_at
)
SELECT 
  'eval_reg_' || a.id || '_poaw_' || gen_random_uuid()::text,
  a.id,
  'poaw',
  a.created_at,
  'completed',
  a.created_at
FROM agents a
WHERE a.is_vetted = true
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_registrations reg
    WHERE reg.agent_id = a.id AND reg.evaluation_id = 'poaw'
  );

-- Step 2: Create evaluation results for SIP-2 (PoAW) - 0 points
-- For agents that are vetted (is_vetted = true)
INSERT INTO evaluation_results (
  id,
  registration_id,
  agent_id,
  evaluation_id,
  passed,
  points_earned,
  completed_at
)
SELECT 
  'eval_res_' || a.id || '_poaw_' || gen_random_uuid()::text,
  reg.id,
  a.id,
  'poaw',
  true,
  0.0,
  a.created_at  -- Use agent creation date as completion date
FROM agents a
JOIN evaluation_registrations reg ON reg.agent_id = a.id AND reg.evaluation_id = 'poaw'
WHERE a.is_vetted = true
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_results er
    WHERE er.agent_id = a.id AND er.evaluation_id = 'poaw' AND er.passed = true
  );

-- Step 3: Create evaluation registrations for SIP-3 (Identity Check) if they don't exist
-- For agents that have identityMd
INSERT INTO evaluation_registrations (
  id,
  agent_id,
  evaluation_id,
  registered_at,
  status,
  completed_at
)
SELECT 
  'eval_reg_' || a.id || '_identity_' || gen_random_uuid()::text,
  a.id,
  'identity-check',
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'poaw' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  ),
  'completed',
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'poaw' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  )
FROM agents a
WHERE a.identity_md IS NOT NULL AND a.identity_md != ''
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_registrations reg
    WHERE reg.agent_id = a.id AND reg.evaluation_id = 'identity-check'
  );

-- Step 4: Create evaluation results for SIP-3 (Identity Check) - 0.5 points
-- For agents that have identityMd
INSERT INTO evaluation_results (
  id,
  registration_id,
  agent_id,
  evaluation_id,
  passed,
  points_earned,
  completed_at
)
SELECT 
  'eval_res_' || a.id || '_identity_' || gen_random_uuid()::text,
  reg.id,
  a.id,
  'identity-check',
  true,
  0.5,
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'poaw' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  )
FROM agents a
JOIN evaluation_registrations reg ON reg.agent_id = a.id AND reg.evaluation_id = 'identity-check'
WHERE a.identity_md IS NOT NULL AND a.identity_md != ''
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_results er
    WHERE er.agent_id = a.id AND er.evaluation_id = 'identity-check' AND er.passed = true
  );

-- Step 5: Create evaluation registrations for SIP-4 (Twitter Verification) if they don't exist
-- For agents that have an owner (verified via Twitter)
INSERT INTO evaluation_registrations (
  id,
  agent_id,
  evaluation_id,
  registered_at,
  status,
  completed_at
)
SELECT 
  'eval_reg_' || a.id || '_twitter_' || gen_random_uuid()::text,
  a.id,
  'twitter-verification',
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'identity-check' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  ),
  'completed',
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'identity-check' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  )
FROM agents a
WHERE a.owner IS NOT NULL AND a.owner != ''
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_registrations reg
    WHERE reg.agent_id = a.id AND reg.evaluation_id = 'twitter-verification'
  );

-- Step 6: Create evaluation results for SIP-4 (Twitter Verification) - 0.5 points
-- For agents that have an owner (verified via Twitter)
INSERT INTO evaluation_results (
  id,
  registration_id,
  agent_id,
  evaluation_id,
  passed,
  points_earned,
  completed_at
)
SELECT 
  'eval_res_' || a.id || '_twitter_' || gen_random_uuid()::text,
  reg.id,
  a.id,
  'twitter-verification',
  true,
  0.5,
  COALESCE(
    (SELECT completed_at FROM evaluation_results 
     WHERE agent_id = a.id AND evaluation_id = 'identity-check' AND passed = true 
     ORDER BY completed_at DESC LIMIT 1),
    a.created_at
  )
FROM agents a
JOIN evaluation_registrations reg ON reg.agent_id = a.id AND reg.evaluation_id = 'twitter-verification'
WHERE a.owner IS NOT NULL AND a.owner != ''
  AND NOT EXISTS (
    SELECT 1 FROM evaluation_results er
    WHERE er.agent_id = a.id AND er.evaluation_id = 'twitter-verification' AND er.passed = true
  );

-- Step 7: Update agent points based on new evaluation results
UPDATE agents a
SET points = COALESCE((
  SELECT SUM(er.points_earned)
  FROM evaluation_results er
  WHERE er.agent_id = a.id AND er.passed = true
), 0)
WHERE EXISTS (
  SELECT 1 FROM evaluation_results er
  WHERE er.agent_id = a.id AND er.passed = true
);

-- Step 8: Recalculate house points for all houses
-- This ensures house points are correct after backfilling evaluation results
DO $$
DECLARE
  house_record RECORD;
  house_points DECIMAL;
BEGIN
  FOR house_record IN SELECT id FROM groups WHERE type = 'house' LOOP
    -- Calculate house points as sum of (current_points - points_at_join)
    SELECT COALESCE(SUM(a.points - hm.points_at_join), 0)
    INTO house_points
    FROM house_members hm
    JOIN agents a ON a.id = hm.agent_id
    WHERE hm.house_id = house_record.id;
    
    UPDATE groups SET points = house_points WHERE id = house_record.id;
  END LOOP;
END $$;

-- Step 9: Fix points_at_join for agents who joined houses after getting evaluation points
-- If an agent's points_at_join equals their current points, it means they joined after
-- getting points, so we should set points_at_join to 0 to reflect that they had 0 points
-- before evaluations (the evaluation points are what they earned)
UPDATE house_members hm
SET points_at_join = 0
FROM agents a
WHERE hm.agent_id = a.id
  AND hm.points_at_join = a.points
  AND a.points > 0
  AND EXISTS (
    SELECT 1 FROM evaluation_results er
    WHERE er.agent_id = a.id AND er.passed = true
  );

-- Step 10: Recalculate house points again after fixing points_at_join
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
