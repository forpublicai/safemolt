-- M11-2 u2 (P2.1) — the three schema facts the event consumers need.
--
-- **Recorded deviation: the plan pins the notification `dedup_key` column to "lands with P1.2" (u3),
-- and this lands it one deploy earlier.** The notifications consumer module ships in THIS deploy and
-- its `INSERT … ON CONFLICT (dedup_key) DO NOTHING` names the column, so the column has to exist
-- before that code can run at all. Landing it early breaks nothing: a column that predates every
-- writer is NULL on every existing row, the unique index admits multiple NULLs, and P1.2's
-- transitional inline writer starts stamping keys into it exactly when the plan said it would.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, and re-running is the recovery path. A file
-- that raises records nothing and rolls back (M11-1 C1).
--
-- The postconditions are written against `current_schema()` and unqualified `regclass` lookups
-- rather than a hardcoded `public`, so they verify whichever schema the file actually ran in. That
-- is what lets `src/__tests__/integration/m11-2-u2-migration.test.ts` apply this file to a scratch
-- schema built to the PRE-u2 shape — the only place the upgrade path can be exercised, since the
-- harness database has long since been upgraded.

-- ==================== 1. The activity monotonic guard ====================

-- Consumption is explicitly unordered and drainers are concurrent (P2.2), and the activity upsert
-- replaces every field on conflict — so a late-consumed OLDER event for a reused natural key would
-- overwrite the newer projection and move the public trail backward. The follow row is the canonical
-- case: one `follower:followee` key is reused across every re-follow. The consumer's `DO UPDATE`
-- carries `WHERE COALESCE(activity_events.source_event_id, 0) <= EXCLUDED.source_event_id`.
--
-- NULLABLE on purpose: every row written before this column existed, and every row the legacy inline
-- writers still write, carries NULL — and `COALESCE(…, 0)` is what makes those rows yield to any
-- event rather than freeze.
ALTER TABLE activity_events ADD COLUMN IF NOT EXISTS source_event_id BIGINT;

-- ==================== 2. The notification dedup key ====================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- **FULL, not partial** (Decision 6). Two reasons, and neither is a preference:
--   - `ON CONFLICT (dedup_key)` cannot infer a PARTIAL index without repeating its predicate, and
--     the consumer's insert targets the bare column;
--   - Postgres unique indexes admit multiple NULLs, so a full index costs nothing for the rows that
--     predate the column — they all carry NULL and coexist happily.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(dedup_key);

-- ==================== 3. The ingest recipient-progress ledger ====================

-- **The event receipt is not the progress marker.** One ingest event fans out to up to 2,000
-- recipients processed sequentially with awaited external vector work per recipient, and before the
-- worker ships the five-minute drain route is the only consumer runtime. A serverless timeout after
-- recipient N would leave no receipt, and every retry would restart at recipient 1 and could never
-- reach the tail. One row per recipient, completed after that recipient's vector work, makes a retry
-- resume at the first unfinished one.
--
-- A row is written at REGISTRATION and finished later, so `completed_at IS NOT NULL` is the only
-- thing that means "done". There is no per-recipient claim: ownership of a fan-out is singular per
-- EVENT (`ingest_event_claims` below), so every row here is written by one owner at a time.
--
-- No FK to `events`: the log is pruned by policy rather than by cascade, and P2.2's retention
-- collects these rows behind their event exactly as it collects receipts and shadow rows.
CREATE TABLE IF NOT EXISTS ingest_progress (
  event_id BIGINT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (event_id, recipient_agent_id)
);

-- Upgrade-safe for the development databases that applied earlier shapes of this file: the first
-- had no `completed_at`, the second added per-recipient claim columns that the event-level claim
-- replaced. Existing rows keep `completed_at` NULL, so the owner treats them as outstanding and
-- resolves them once; the effects are idempotent under their chunk ids, so that costs a rewrite and
-- nothing else.
ALTER TABLE ingest_progress ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE ingest_progress DROP COLUMN IF EXISTS claim_token;
ALTER TABLE ingest_progress DROP COLUMN IF EXISTS lease_expires_at;

-- ==================== 4. The ingest fan-out claim ====================

-- **Fan-out ownership is singular per event.** Recipient effects are only idempotent while they are
-- pure writes; the deletion COMPENSATION makes them delete-then-rewrite, which does not commute — a
-- slow pass can land an upsert after a faster one already compensated the same chunks away, leaving
-- deleted content indexed behind a receipt nobody revisits. Guarding each recipient separately
-- closes that one interleaving and opens others, because a fan-out also has a shared audience
-- recompute, a shared registration and a shared completeness decision. One owner per event removes
-- the class: a racing pass cannot register a recipient, because it does not hold the claim.
--
-- One row per in-flight fan-out, deleted on the way out; a crashed owner's row is reclaimable once
-- its lease lapses, and retention collects any row whose event is gone.
CREATE TABLE IF NOT EXISTS ingest_event_claims (
  event_id BIGINT PRIMARY KEY,
  claim_token TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL
);

-- ==================== Postconditions ====================
--
-- `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` are no-ops against a pre-existing
-- shape, so what the consumer statements depend on is asserted rather than assumed.
DO $$
BEGIN
  -- BIGINT because event ids are BIGSERIAL; a narrower type silently truncates the comparison the
  -- monotonic guard makes, and a TEXT column would compare lexically ("10" < "9").
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'activity_events'
      AND column_name = 'source_event_id' AND data_type = 'bigint' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: activity_events.source_event_id is not a nullable BIGINT';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'notifications'
      AND column_name = 'dedup_key' AND data_type = 'text' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: notifications.dedup_key is not a nullable TEXT';
  END IF;

  -- UNIQUE, on `dedup_key`, and NOT partial. Each half is load-bearing and none follows from the
  -- others: not unique -> two drainers each write the notification; wrong column -> the
  -- deduplication is on something else; PARTIAL -> `ON CONFLICT (dedup_key)` cannot infer the index
  -- and every consumer insert raises 42P10 instead of deduplicating.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'notifications'::regclass
      AND c.relname = 'idx_notifications_dedup'
      AND i.indisunique
      AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['dedup_key']
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: idx_notifications_dedup is not a FULL UNIQUE(dedup_key) index';
  END IF;

  -- The resume predicate reads `(event_id, recipient_agent_id)` and the progress insert targets this
  -- primary key with `ON CONFLICT DO NOTHING`; without it a concurrent drain records a duplicate
  -- instead of no-opping.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'ingest_progress'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['event_id', 'recipient_agent_id']
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: ingest_progress primary key (event_id, recipient_agent_id) is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ingest_progress'
      AND column_name = 'event_id' AND data_type = 'bigint' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ingest_progress'
      AND column_name = 'recipient_agent_id' AND data_type = 'text' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: ingest_progress columns have the wrong shape';
  END IF;

  -- `completed_at` NULLABLE: NULL is "registered, not finished", which is exactly what the
  -- outstanding-recipient query tests for. A NOT NULL would make a registered row unrepresentable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ingest_progress'
      AND column_name = 'completed_at' AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: ingest_progress.completed_at is missing or not nullable';
  END IF;

  -- The per-recipient claim columns must be GONE. They are what the event-level claim replaced, and
  -- a database that kept them would let a future reader believe recipients are individually owned.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ingest_progress'
      AND column_name IN ('claim_token', 'lease_expires_at')
  ) THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: ingest_progress still carries per-recipient claim columns';
  END IF;

  -- The claim table. Both columns NOT NULL: a claim with no token cannot be fenced and a claim with
  -- no lease can never be reclaimed, so neither is a representable state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'ingest_event_claims'::regclass
      AND i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
          = ARRAY['event_id']
  ) OR (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ingest_event_claims'
      AND is_nullable = 'NO'
      AND ((column_name = 'event_id' AND data_type = 'bigint')
        OR (column_name = 'claim_token' AND data_type = 'text')
        OR (column_name = 'lease_expires_at' AND data_type = 'timestamp with time zone'))
  ) <> 3 THEN
    RAISE EXCEPTION 'M11-2 u2 postcondition failed: ingest_event_claims has the wrong shape';
  END IF;
END
$$;
