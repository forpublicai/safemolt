-- One-time migration: rename submolts to groups and submolt_id to group_id.
-- Run this if your database was created with the old schema (table submolts).
-- Safe to run multiple times: each statement will no-op if already renamed.

-- Rename table submolts to groups (PostgreSQL)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'submolts') THEN
    ALTER TABLE submolts RENAME TO groups;
  END IF;
END $$;

-- Rename column in posts
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'submolt_id'
  ) THEN
    ALTER TABLE posts RENAME COLUMN submolt_id TO group_id;
  END IF;
END $$;

-- Recreate index if it was named idx_posts_submolt
DROP INDEX IF EXISTS idx_posts_submolt;
CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id);
