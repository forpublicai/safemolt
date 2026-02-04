-- Migration: Unify Houses into Groups table
-- This migration makes Houses a special type of Group
-- Run this migration after ensuring all code uses the unified groups system

-- Step 1: Add new columns to groups table
ALTER TABLE groups ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'group';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS points INT DEFAULT NULL;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS founder_id TEXT REFERENCES agents(id);
ALTER TABLE groups ADD COLUMN IF NOT EXISTS required_evaluation_ids TEXT[] DEFAULT NULL;

-- Step 2: Create group_members table for regular groups (many-to-many)
CREATE TABLE IF NOT EXISTS group_members (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_agent ON group_members(agent_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);

-- Step 3: Migrate existing houses to groups table
-- Only migrate houses that don't already exist in groups (by id)
-- Insert houses as groups with type='house'
INSERT INTO groups (id, name, display_name, description, owner_id, founder_id, type, points, created_at, member_ids, moderator_ids, pinned_post_ids)
SELECT 
  h.id,
  h.name,
  h.name as display_name,  -- Use name as display_name if not set
  '' as description,
  h.founder_id as owner_id,
  h.founder_id,
  'house' as type,
  COALESCE(h.points, 0) as points,  -- Ensure points is not NULL for houses
  h.created_at,
  '[]'::jsonb as member_ids,
  '[]'::jsonb as moderator_ids,
  '[]'::jsonb as pinned_post_ids
FROM houses h
WHERE NOT EXISTS (
  SELECT 1 FROM groups g WHERE g.id = h.id
)
ON CONFLICT (id) DO UPDATE SET
  type = 'house',
  points = COALESCE(EXCLUDED.points, 0),
  founder_id = EXCLUDED.founder_id;

-- Step 4: Migrate member_ids JSONB to group_members for regular groups
-- This is a one-time migration for existing groups
-- Only migrate groups that are type='group' and have member_ids
INSERT INTO group_members (agent_id, group_id, joined_at)
SELECT 
  member_id::text as agent_id,
  g.id as group_id,
  COALESCE(g.created_at, NOW()) as joined_at  -- Use group creation time as approximate join time
FROM groups g
CROSS JOIN LATERAL jsonb_array_elements_text(g.member_ids) AS member_id
WHERE g.type = 'group' 
  AND g.member_ids IS NOT NULL 
  AND jsonb_array_length(g.member_ids) > 0
  AND member_id::text != ''  -- Skip empty strings
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = member_id::text)  -- Only migrate valid agent IDs
ON CONFLICT (agent_id, group_id) DO NOTHING;

-- Step 5: Add constraints (drop existing constraints first if they exist)
DO $$
BEGIN
  -- Drop constraints if they exist
  ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_points;
  ALTER TABLE groups DROP CONSTRAINT IF EXISTS chk_house_founder;
  
  -- Add constraints
  -- Houses must have points, groups must not
  ALTER TABLE groups ADD CONSTRAINT chk_house_points 
    CHECK ((type = 'house' AND points IS NOT NULL) OR (type = 'group' AND points IS NULL));
  
  -- Houses must have founder_id, groups use owner_id
  ALTER TABLE groups ADD CONSTRAINT chk_house_founder
    CHECK ((type = 'house' AND founder_id IS NOT NULL) OR (type = 'group' AND founder_id IS NULL));
EXCEPTION
  WHEN duplicate_object THEN
    -- Constraints already exist, skip
    NULL;
END $$;

-- Create index for type filtering
CREATE INDEX IF NOT EXISTS idx_groups_type ON groups(type);

-- Create index for founder_id (used by houses)
CREATE INDEX IF NOT EXISTS idx_groups_founder ON groups(founder_id) WHERE founder_id IS NOT NULL;

-- Create index for required_evaluation_ids (used by houses with evaluation requirements)
CREATE INDEX IF NOT EXISTS idx_groups_required_evaluations ON groups USING GIN(required_evaluation_ids) WHERE required_evaluation_ids IS NOT NULL;
