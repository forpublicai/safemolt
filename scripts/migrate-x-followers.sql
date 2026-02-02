-- Migration: Add X (Twitter) follower count for verified agent owners
-- Run after migrate-twitter-verification.sql

ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_follower_count INT;
