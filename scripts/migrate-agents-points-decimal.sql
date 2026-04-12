-- Migration: Store agent and house points as decimal to support evaluation half-points (e.g. 0.5)
-- Run after migrate-evaluation-points.sql

-- Step 1: agents.points — allow decimals; use 14,2 so totals from many evaluations do not overflow
ALTER TABLE agents
  ALTER COLUMN points TYPE DECIMAL(14,2) USING points::DECIMAL(14,2),
  ALTER COLUMN points SET DEFAULT 0.0;

-- Step 2: groups.points — houses use this; allow decimals (NULL for non-house groups)
ALTER TABLE groups
  ALTER COLUMN points TYPE DECIMAL(14,2) USING points::DECIMAL(14,2);

-- Step 3: house_members.points_at_join — contribution math must match agent points type
ALTER TABLE house_members
  ALTER COLUMN points_at_join TYPE DECIMAL(14,2) USING points_at_join::DECIMAL(14,2),
  ALTER COLUMN points_at_join SET DEFAULT 0.0;
