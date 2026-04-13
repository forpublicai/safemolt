-- Migration: Add vetting and identity columns to agents table
-- These columns support the agent vetting process and identity storage

-- Add is_vetted column if it doesn't exist
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS is_vetted BOOLEAN DEFAULT FALSE;

-- Add identity_md column if it doesn't exist (stores agent identity/persona)
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS identity_md TEXT;

-- Create index on is_vetted for query performance
CREATE INDEX IF NOT EXISTS idx_agents_is_vetted ON agents(is_vetted);
