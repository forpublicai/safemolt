-- M11-1 C12: leased per-(session, round) playground resolution claim + real action uniqueness.
--
-- Round resolution was check-then-act with no coordination: the unauthenticated session-detail
-- GET invoked checkDeadlines(), whose only coalescing was a process-local Set — so concurrent
-- public requests on different instances each triggered a billed GM call. The claim columns give
-- resolution a durable lease: a resolver claims (round, token) before enumerating actions and
-- before inference, renews during long inference, and every terminal write is fenced on
-- (status, current_round, resolve_claim_token).
--
-- idx_pg_actions_unique already ships in scripts/schema.sql (session_id, agent_id, round), but a
-- database whose schema predates that line has no such index and no migration ever ensured it —
-- so this file makes it a guarantee rather than an accident of schema age.
--
-- REFUSE, do not delete (M11-1b review B4). An earlier draft collapsed duplicate actions
-- keep-earliest, arguing later duplicates were "already invisible". They are not: the public
-- session GET maps EVERY current-round action into its returned transcript, and the playground
-- tool returns every row — so deleting a later duplicate destroys agent-authored content a reader
-- can see. Duplicate actions on one (session, round, agent) are also genuinely ambiguous (which
-- is canonical?), so — exactly as C5's case-fold collisions and C23's multi-live sessions — no
-- automatic rule is safe. Production carried none (C0 report 14 empty, 2026-07-27); any database
-- that does gets a loud, information-preserving refusal and a human decides. The preflight wording
-- avoids the substrings the runner's dropped swallow filter used to match.
--
-- Idempotent (Locked decision 5): once duplicates are resolved by hand, re-running applies clean.

ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS resolve_claim_token TEXT;
ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS resolve_claim_expires_at TIMESTAMPTZ;

DO $$
DECLARE
  colliding text;
BEGIN
  SELECT string_agg(format('%s/round %s/%s (%s rows)', session_id, round, agent_id, cnt), ', ')
    INTO colliding
  FROM (
    SELECT session_id, round, agent_id, count(*) AS cnt
    FROM playground_actions
    GROUP BY session_id, round, agent_id
    HAVING count(*) > 1
  ) AS dups;

  IF colliding IS NOT NULL THEN
    RAISE EXCEPTION
      'C12: multiple actions for the same (session, round, agent): %. These are reader-visible, agent-authored rows with no safe automatic rule — pick the canonical one by hand and re-run. Nothing was changed.',
      colliding;
  END IF;
END
$$;

-- Column order matches the schema.sql definition so IF NOT EXISTS is a true no-op there.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_actions_unique
  ON playground_actions (session_id, agent_id, round);

-- Postconditions: the columns and the unique index, pinned to the right table (indrelid), with
-- the exact column list — rolling the file back if any shape is missing.
DO $$
BEGIN
  -- Nullability and default, not type alone. `ADD COLUMN IF NOT EXISTS` is a no-op against a
  -- pre-existing column, so a `resolve_claim_token TEXT NOT NULL DEFAULT ''` left by an earlier
  -- hand would satisfy a type-only check — and then no session could ever be claimed (the lease
  -- is taken by writing a token where none is held) and every terminal write, which clears the
  -- lease back to NULL, would fail outright. An unheld lease must be representable as NULL.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_sessions'
      AND column_name = 'resolve_claim_token' AND data_type = 'text'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'playground_sessions'
      AND column_name = 'resolve_claim_expires_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'C12 postcondition failed: playground_sessions resolution-claim columns are missing or are not nullable-with-no-default (an unheld lease must be representable as NULL)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = 'idx_pg_actions_unique'
      AND i.indrelid = 'public.playground_actions'::regclass
      AND i.indisunique AND i.indisvalid
      AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['session_id', 'agent_id', 'round']
  ) THEN
    RAISE EXCEPTION 'C12 postcondition failed: unique index idx_pg_actions_unique on playground_actions (session_id, agent_id, round) is missing';
  END IF;
END
$$;
