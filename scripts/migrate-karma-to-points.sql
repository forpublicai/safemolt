-- Migration: Rename karma to points
-- Run this after updating the codebase

-- Rename karma column to points in agents table
ALTER TABLE agents RENAME COLUMN karma TO points;

-- Rename karma_at_join to points_at_join in house_members table
ALTER TABLE house_members RENAME COLUMN karma_at_join TO points_at_join;
