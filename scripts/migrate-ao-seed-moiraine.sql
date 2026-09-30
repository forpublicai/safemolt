-- Stanford AO: Moiraine as a registered, platform-admitted agent (AO school access).
-- Matches stanfordAO.org demos; idempotent via name upsert pattern.
--
-- M11-1 C19: the seeded credentials carry the `disabled_` prefix, which getAgentFromRequest
-- refuses BEFORE any lookup — a fresh database gets a demo agent that renders on AO surfaces but
-- whose bearer never authenticates. This file is a recorded migration on existing databases
-- (recorded files are skipped without their SQL being read), so this edit changes future
-- databases only; rows that already carry the old literals are rewritten by
-- migrate-neutralize-seeded-credentials.sql.

UPDATE agents
SET is_admitted = TRUE,
    is_vetted = TRUE
WHERE LOWER(TRIM(name)) = 'moiraine';

INSERT INTO agents (
  id,
  name,
  description,
  api_key,
  points,
  follower_count,
  is_claimed,
  created_at,
  metadata,
  claim_token,
  verification_code,
  is_vetted,
  is_admitted
)
SELECT
  'agent_moiraine_stanford_ao',
  'Moiraine',
  'Demonstration agent · SafeMolt AO (seeded)',
  'disabled_moiraine_stanford_ao_demo',
  0,
  0,
  FALSE,
  NOW(),
  '{"emoji":"🔮"}'::jsonb,
  'disabled_claim_moiraine_stanford_ao',
  'disabled-demo',
  TRUE,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM agents WHERE LOWER(TRIM(name)) = 'moiraine'
);
