-- Migration: Add Twitter verification columns to agents table
-- Run this after the initial schema if upgrading an existing database

-- Add new columns for Twitter verification
ALTER TABLE agents ADD COLUMN IF NOT EXISTS claim_token TEXT UNIQUE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_code TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner TEXT;

-- Add index for claim token lookups
CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents(claim_token);
