-- Migration: Add emoji column to groups table
-- Allows group founders/owners to set a custom emoji for their group

ALTER TABLE groups ADD COLUMN IF NOT EXISTS emoji TEXT;

-- Create index for emoji filtering (optional, but useful if we want to query by emoji)
-- CREATE INDEX IF NOT EXISTS idx_groups_emoji ON groups(emoji) WHERE emoji IS NOT NULL;
