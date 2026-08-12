-- M11-2 u1 (P1.0 + P2.2) — the event substrate: the append-only log and the consumer ledgers.
--
-- `events` is authoritative history for agent-initiated platform actions. Everything else here is
-- per-consumer bookkeeping over it, and the split is deliberate: **receipts are the correctness
-- mechanism, the cursor is only a scan floor.** Sequence ids allocate before commit, so a scalar
-- cursor can always be advanced past an id whose transaction has not committed yet; with a receipt
-- per (consumer, event) nothing is ever "passed" — a late-committing event is simply still
-- receipt-less and the next scan picks it up.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, re-running is the recovery path.

-- ==================== The log ====================

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_agent_id TEXT,          -- no FK: rows may outlive agents; consumers tolerate dangling actors
  subject_type TEXT, subject_id TEXT, secondary_subject_id TEXT,
  school_id TEXT,
  idem_key TEXT,                -- deterministic domain key where stamped (playground actions); usually NULL
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_kind_id ON events(kind, id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_agent_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idem ON events(idem_key) WHERE idem_key IS NOT NULL;

-- ==================== Per-consumer cursor ====================

-- `last_event_id` is the fast path's low-water scan floor and carries NO correctness claim;
-- `activation_cutoff` is the fence id from the consumer's activation event. Both are written by the
-- single activation insert, so "start from now" survives restarts. `DEFAULT 0` is never an
-- activation state — a consumer with no row is inactive and its drain is a no-op.
CREATE TABLE IF NOT EXISTS event_consumers (
  consumer TEXT PRIMARY KEY,
  last_event_id BIGINT NOT NULL DEFAULT 0,
  activation_cutoff BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Completion is per event, and the primary key is what serializes two drainers racing one event:
-- both may apply the idempotent effect, exactly one records the receipt.
CREATE TABLE IF NOT EXISTS event_receipts (
  consumer TEXT NOT NULL,
  event_id BIGINT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

-- ==================== Retry ledger ====================

-- A failing event gets a row here and NO receipt, so it retries while later events proceed.
-- Attempts are leased (`claim_token` + `lease_expires_at`) and paced (`next_attempt_at`): without
-- the lease a worker and a cron failing the same event would double-count attempts, and without the
-- backoff they would burn all three attempts within minutes of a short provider outage.
CREATE TABLE IF NOT EXISTS event_consumer_failures (
  consumer TEXT NOT NULL,
  event_id BIGINT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ,
  claim_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  PRIMARY KEY (consumer, event_id)
);

-- The terminal record. `UNIQUE (consumer, event_id)` exists so a replayed finalization no-ops
-- rather than duplicating the audit row: the dead letter and the skipped receipt ride ONE
-- data-modifying CTE, and this driver auto-commits every statement, so a two-call form would have a
-- crash window in which the event is either eternally rescanned or silently missing its audit row.
CREATE TABLE IF NOT EXISTS event_dead_letters (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT,
  consumer TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consumer, event_id)
);

-- ==================== Shadow comparison rows ====================

-- Written from u2 on, by consumers whose coverage manifest puts a kind in `shadow`: the consumer
-- computes its intended effects and records them here INSTEAD of writing real projections, so the
-- soak can diff them against the legacy inline writer's output. `effect_key` is the consumer's own
-- natural key (notification dedup key, activity upsert key, ingest chunk key). Inserted
-- `ON CONFLICT DO NOTHING` because drains are at-least-once and duplicate rows would corrupt the
-- mismatch counts. The schema ships here so u2 is a code-only deploy.
CREATE TABLE IF NOT EXISTS event_consumer_shadow (
  id BIGSERIAL PRIMARY KEY,
  consumer TEXT,
  event_id BIGINT,
  effect_key TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consumer, event_id, effect_key)
);

-- ==================== Runtime heartbeats ====================

-- P3.4 names this table for `meta.mode`; it is created here because the drain route stamps it from
-- day one. `contract_hash` is the deployment-version barrier's signal: a runtime that is alive and
-- healthy can still receipt an event under an OLD effect set, so the barrier compares contract
-- identity, never liveness.
--
-- **The primary key is (worker_id, contract_hash), and that is the barrier's correctness.** With
-- `worker_id` alone the row is last-writer-wins: during a rolling deploy the first NEW invocation
-- overwrites the hash while an OLD invocation is still mid-drain, so the barrier would report the
-- target contract everywhere and let a cutover proceed while the old effect set could still receipt
-- an event. One row per (runtime, contract) makes the old contract's liveness observable — the
-- barrier passes only when the target row is fresh AND every other hash row for that runtime is
-- stale by more than one invocation's lifetime.
--
-- **Completion alone is not the signal, and that is the second half of the correctness.** A stamp
-- written only when a drain FINISHES cannot see an invocation that is still inside one: the old
-- build's last completion goes stale while its current invocation is mid-drain, the new build's
-- completion is fresh, and the barrier passes while the old effect set can still receipt an event.
-- So each invocation leases `active_until` BEFORE it drains and stamps `completed_at` after, and
-- the barrier reads both: a fresh completion for the target hash AND no other hash still in flight.
--
-- The hourly-duty claim uses this table too, under its own `worker_id` and the empty hash. It is a
-- duty claim, never a barrier signal.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id TEXT NOT NULL,
  contract_hash TEXT NOT NULL DEFAULT '',
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (worker_id, contract_hash)
);
ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS active_until TIMESTAMPTZ;
ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Upgrade a table an earlier run of this file created with the single-column key. Written as a
-- conditional block rather than a bare ALTER so re-running the file stays the recovery path.
DO $$
DECLARE
  pk_name TEXT;
  pk_cols TEXT[];
BEGIN
  ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS contract_hash TEXT;
  -- Pre-hash rows: the empty string is "no contract reported", which the barrier reads as an
  -- unknown contract rather than as the target one. NULL could not be part of a primary key.
  UPDATE worker_heartbeats SET contract_hash = '' WHERE contract_hash IS NULL;
  ALTER TABLE worker_heartbeats ALTER COLUMN contract_hash SET DEFAULT '';
  ALTER TABLE worker_heartbeats ALTER COLUMN contract_hash SET NOT NULL;

  SELECT c.conname,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum)
    INTO pk_name, pk_cols
  FROM pg_constraint c
  WHERE c.conrelid = 'public.worker_heartbeats'::regclass AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM ARRAY['worker_id', 'contract_hash'] THEN
    IF pk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE worker_heartbeats DROP CONSTRAINT %I', pk_name);
    END IF;
    ALTER TABLE worker_heartbeats ADD PRIMARY KEY (worker_id, contract_hash);
  END IF;
END
$$;

-- ==================== Postconditions ====================
--
-- `CREATE TABLE IF NOT EXISTS` is a no-op against a pre-existing table, so the shapes every
-- statement in `src/lib/store/events/` depends on are asserted rather than assumed. A file that
-- raises here records nothing and rolls back (M11-1 C1).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events'
      AND column_name = 'payload' AND data_type = 'jsonb' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: events.payload is not JSONB NOT NULL';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events'
      AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: events.created_at is not TIMESTAMPTZ NOT NULL';
  END IF;

  -- Every subject column the emit renderer names, and every one of them NULLABLE: an event whose
  -- kind has no secondary subject or no school writes NULL there, so a NOT NULL would refuse it.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'events'
      AND column_name IN ('kind', 'actor_agent_id', 'subject_type', 'subject_id',
                          'secondary_subject_id', 'school_id', 'idem_key')
      AND data_type = 'text'
      AND (column_name = 'kind') = (is_nullable = 'NO')
  ) <> 7 THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: events subject columns are not TEXT with kind NOT NULL and the rest nullable';
  END IF;

  -- The idempotency index must be UNIQUE, on `idem_key`, and PARTIAL on exactly
  -- `idem_key IS NOT NULL`. Each half is load-bearing and none of them follows from the others:
  --   - not unique      -> a retried producer writes the event twice;
  --   - wrong column    -> the deduplication is on something else entirely;
  --   - not partial     -> the overwhelmingly common NULL case collapses into ONE row platform-wide;
  --   - wider predicate -> some keys silently stop deduplicating.
  -- `activateEventConsumer` also repeats this predicate in its `ON CONFLICT` target, so a changed
  -- predicate turns that statement into a runtime error rather than a silent regression.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.events'::regclass
      AND c.relname = 'idx_events_idem'
      AND i.indisunique
      AND pg_get_expr(i.indpred, i.indrelid) = '(idem_key IS NOT NULL)'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['idem_key']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: idx_events_idem is not UNIQUE(idem_key) WHERE idem_key IS NOT NULL';
  END IF;

  -- Both scan indexes. The drain orders by id within a kind filter, and the actor index serves the
  -- per-agent history reads P4 adds; a missing one is a sequential scan over the whole log.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE i.indrelid = 'public.events'::regclass AND c.relname = 'idx_events_kind_id'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['kind', 'id']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE i.indrelid = 'public.events'::regclass AND c.relname = 'idx_events_actor'
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['actor_agent_id', 'id']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: idx_events_kind_id or idx_events_actor is missing or mis-keyed';
  END IF;

  -- The receipt anti-join and the two-drainer race both rest on this primary key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.event_receipts'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['consumer', 'event_id']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_receipts primary key (consumer, event_id) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.event_consumer_failures'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['consumer', 'event_id']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_consumer_failures primary key (consumer, event_id) is missing';
  END IF;

  -- The finalization CTE targets this constraint by name-free `ON CONFLICT (consumer, event_id)`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.event_dead_letters'::regclass
      AND i.indisunique AND NOT i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['consumer', 'event_id']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_dead_letters unique (consumer, event_id) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.event_consumer_shadow'::regclass
      AND i.indisunique AND NOT i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['consumer', 'event_id', 'effect_key']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_consumer_shadow unique (consumer, event_id, effect_key) is missing';
  END IF;

  -- The ledger columns the drain statements name, with the types and nullabilities they rely on.
  -- `CREATE TABLE IF NOT EXISTS` is a no-op against a pre-existing table, so a table that arrived
  -- from an earlier hand-run script with a different shape would otherwise pass unnoticed until a
  -- consumer failed in production.
  IF NOT EXISTS (
    -- The cursor arithmetic is numeric: `GREATEST(last_event_id, …)` against a TEXT column would
    -- compare lexically, and a NULL would make the whole expression NULL and freeze the floor.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumers'
      AND column_name = 'last_event_id' AND data_type = 'bigint' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumers'
      AND column_name = 'activation_cutoff' AND data_type = 'bigint' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumers'
      AND column_name = 'updated_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    -- Activation targets this key with `ON CONFLICT (consumer) DO NOTHING`; without it a second
    -- activation would insert a second cursor row instead of no-opping.
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.event_consumers'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['consumer']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_consumers cursor columns or primary key are wrong';
  END IF;

  IF NOT EXISTS (
    -- `attempts` is compared against the attempt ceiling and incremented; NULL would never reach it.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'attempts' AND data_type = 'integer' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    -- The lease and the pacing stamp must both be nullable: NULL is "not leased" / "ready now",
    -- which is exactly what the claim predicate tests for.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'next_attempt_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'lease_expires_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'claim_token' AND data_type = 'text' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'last_error' AND data_type = 'text' AND is_nullable = 'YES'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_failures'
      AND column_name = 'event_id' AND data_type = 'bigint' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_consumer_failures lease/pacing columns have the wrong shape';
  END IF;

  IF NOT EXISTS (
    -- Retention reads `created_at` on both ledgers, and a NULL age would never be pruned.
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_dead_letters'
      AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_dead_letters'
      AND column_name = 'error' AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_dead_letters'
      AND column_name = 'event_id' AND data_type = 'bigint'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_consumer_shadow'
      AND column_name = 'payload' AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: event_dead_letters or event_consumer_shadow has the wrong shape';
  END IF;

  -- The barrier's own shape. `contract_hash` must be NOT NULL and part of the primary key: with
  -- `worker_id` alone the row is last-writer-wins, and a rolling deploy would hide an old contract
  -- that is still draining behind the new one's stamp.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_heartbeats'
      AND column_name = 'seen_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_heartbeats'
      AND column_name = 'contract_hash' AND data_type = 'text' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'public.worker_heartbeats'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['worker_id', 'contract_hash']
  ) THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: worker_heartbeats is not keyed on (worker_id, contract_hash)';
  END IF;

  -- Both halves of the barrier signal, and both NULLABLE: a row that has leased but not yet
  -- completed carries a NULL `completed_at`, which is exactly the state the barrier must refuse.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_heartbeats'
      AND column_name IN ('active_until', 'completed_at')
      AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
  ) <> 2 THEN
    RAISE EXCEPTION 'M11-2 u1 postcondition failed: worker_heartbeats.active_until/completed_at are missing or not nullable TIMESTAMPTZ';
  END IF;
END
$$;
