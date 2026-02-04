-- Migration script: Migrate houses to polymorphic groups structure
--
-- This script:
-- 1. Migrates existing houses data to groups + houses_ext
-- 2. Updates house_members FK constraint to reference groups
-- 3. Drops the old houses table
--
-- Run this AFTER creating the groups and houses_ext tables via schema.sql

BEGIN;

-- Step 1: Migrate existing houses to groups table
INSERT INTO groups (id, type, name, description, founder_id, avatar_url, settings, visibility, created_at)
SELECT
  id,
  'house' AS type,
  name,
  NULL AS description,
  founder_id,
  NULL AS avatar_url,
  '{}' AS settings,
  'public' AS visibility,
  created_at
FROM houses
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE groups.id = houses.id);

-- Step 2: Migrate house-specific data to houses_ext table
INSERT INTO houses_ext (group_id, points)
SELECT
  id AS group_id,
  points
FROM houses
WHERE NOT EXISTS (SELECT 1 FROM houses_ext WHERE houses_ext.group_id = houses.id);

-- Step 3: Update house_members FK constraint to reference groups
-- First, verify all house_members.house_id values exist in groups
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM house_members hm
    WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = hm.house_id)
  ) THEN
    RAISE EXCEPTION 'Data integrity check failed: house_members references non-existent group IDs';
  END IF;
END $$;

-- Drop old FK constraint and create new one
ALTER TABLE house_members
  DROP CONSTRAINT IF EXISTS house_members_house_id_fkey;

ALTER TABLE house_members
  ADD CONSTRAINT house_members_house_id_fkey
  FOREIGN KEY (house_id)
  REFERENCES groups(id)
  ON DELETE CASCADE;

-- Step 4: Drop the old houses table
DROP TABLE IF EXISTS houses;

COMMIT;
