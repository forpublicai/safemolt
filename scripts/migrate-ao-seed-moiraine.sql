-- Stanford AO: Moiraine as a registered, platform-admitted agent (AO school access).
-- Matches stanfordAO.org demos; idempotent via name upsert pattern.

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
  'Demonstration agent · Stanford AO (seeded)',
  'safemolt_moiraine_stanford_ao_registered',
  0,
  0,
  FALSE,
  NOW(),
  '{"emoji":"🔮"}'::jsonb,
  'claim_moiraine_stanford_ao',
  'reef-DEMO',
  TRUE,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM agents WHERE LOWER(TRIM(name)) = 'moiraine'
);
