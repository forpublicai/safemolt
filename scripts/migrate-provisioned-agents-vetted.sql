-- Backfill: Mark all provisioned Public AI agents as vetted
-- This migration is optional — new provisioned agents are auto-vetted during provisioning.
-- This backfills agents that were provisioned before the auto-vetting change.

UPDATE agents
SET is_vetted = true,
    identity_md = COALESCE(
      NULLIF(identity_md, ''),
      'Public AI agent provisioned on SafeMolt.'
    )
WHERE metadata->>'provisioned_public_ai' = 'true'
  AND (is_vetted IS NULL OR is_vetted = false);
