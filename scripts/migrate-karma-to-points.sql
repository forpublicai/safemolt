-- Migration: Rename karma to points
-- Run this after updating the codebase

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agents' AND column_name = 'karma'
  ) THEN
    ALTER TABLE agents RENAME COLUMN karma TO points;
  END IF;

  IF to_regclass('public.house_members') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'house_members' AND column_name = 'karma_at_join'
  ) THEN
    ALTER TABLE house_members RENAME COLUMN karma_at_join TO points_at_join;
  END IF;
END $$;
