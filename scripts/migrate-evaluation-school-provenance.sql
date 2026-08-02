-- M11-1 C2: evaluation authorization needs a school it can trust, and a transcript whose order is
-- not ambiguous.
--
-- 1. `evaluation_registrations.school_id` has existed since `migrate-schools.sql`, but
--    `registerForEvaluation` never wrote it — so every registration ever created reads as
--    Foundation whichever school's subdomain it came through. Authorization cannot read that column
--    directly, because the column's DEFAULT is `'foundation'`: once new producers start writing the
--    school explicitly, a row reading `foundation` means either "genuinely Foundation, written by a
--    trusted producer" **or** "unknown, defaulted years ago", and nothing distinguishes them.
--
--    `school_scope_trusted` records provenance instead of guessing. New producers write the
--    middleware-derived school *and* TRUE; every pre-existing row, and anything an old instance
--    writes during the mixed-version window, stays FALSE with no backfill. Authorization branches on
--    the flag, not on the value — untrusted rows resolve their `evaluation_id` against the
--    filesystem and reject outright when the id exists in more than one school.
--
--    The marker is transitional: M11-1b D4 backfills it TRUE once composite definition identity
--    lands, and drops the column.
--
-- 2. `addSessionMessage` computed `MAX(sequence) + 1` with no lock and the only index over
--    `(session_id, sequence)` was non-unique, while transcript reads order by sequence alone. A
--    candidate and a proctor sending concurrently could be assigned the same number, producing an
--    ambiguous transcript in exactly the surface C2 exists to protect. The store now allocates
--    inside a batch that locks the session row; this index is what makes a regression loud instead
--    of silent.
--
-- Idempotent (Locked decision 5): every statement is guarded, so re-running is the recovery path.
-- Preflight wording avoids the two substrings the runner's dropped swallow filter used to match, so
-- a raised error here can never be mistaken for a benign object-exists condition.

ALTER TABLE evaluation_registrations
  ADD COLUMN IF NOT EXISTS school_scope_trusted BOOLEAN NOT NULL DEFAULT FALSE;

-- Repair before constraining. C0 report 5 was empty platform-wide at baseline, so this is expected
-- to touch nothing — but a report is a measurement of one moment and the constraint is forever, so
-- the repair ships with the index rather than being assumed unnecessary.
--
-- Deterministic and idempotent: rows are renumbered 1..n per affected session ordered by
-- (sequence, created_at, id), so re-running over already-repaired data reproduces the same
-- assignment and updates nothing. Only sessions that actually collide are touched — a global
-- renumber would rewrite every transcript in the table to fix none of them.
WITH colliding AS (
  SELECT DISTINCT session_id FROM (
    SELECT session_id FROM evaluation_messages
    GROUP BY session_id, sequence HAVING count(*) > 1
  ) AS collisions
),
renumbered AS (
  SELECT m.id, row_number() OVER (
           PARTITION BY m.session_id ORDER BY m.sequence ASC, m.created_at ASC, m.id ASC
         ) AS position
  FROM evaluation_messages m
  JOIN colliding c ON c.session_id = m.session_id
)
UPDATE evaluation_messages m
SET sequence = renumbered.position
FROM renumbered
WHERE m.id = renumbered.id AND m.sequence IS DISTINCT FROM renumbered.position;

-- `CREATE UNIQUE INDEX IF NOT EXISTS` matches on **name alone**: a same-named index over different
-- columns, or a non-unique one, is silently kept and the migration reports success. The plain
-- `idx_eval_messages_session_seq` from `migrate-multi-agent-sessions.sql` is exactly such a name, so
-- the unique index takes a distinct one and the redundant plain index is dropped afterwards rather
-- than replaced in place — dropping first would open a window with neither index present.
--
-- **The guard reads the catalog, not the rendered definition string, and the difference is not
-- pedantry.** A regex over `pg_get_indexdef` matching `CREATE UNIQUE INDEX … (session_id, sequence)`
-- is also satisfied by `… (session_id, sequence) WHERE role = 'proctor'` — a *partial* index that
-- constrains almost nothing, that `IF NOT EXISTS` would then skip creating, and that would let this
-- file record success while global sequence uniqueness did not exist. So the four properties that
-- actually matter are asserted individually: unique, valid, unpredicated, and keyed on exactly
-- `(session_id, sequence)` in that order.
DO $$
DECLARE
  idx record;
BEGIN
  SELECT i.indisunique, i.indisvalid, i.indpred IS NOT NULL AS partial,
         (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS keys
    INTO idx
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE n.nspname = 'public' AND c.relname = 'idx_eval_messages_session_seq_uniq'
    AND i.indrelid = 'public.evaluation_messages'::regclass;

  IF NOT FOUND THEN
    RETURN; -- absent; the CREATE below makes it
  END IF;

  IF NOT idx.indisunique OR NOT idx.indisvalid OR idx.partial
     OR idx.keys IS DISTINCT FROM ARRAY['session_id', 'sequence'] THEN
    RAISE EXCEPTION
      'C2: index idx_eval_messages_session_seq_uniq has the wrong shape (unique=%, valid=%, partial=%, keys=%). Drop it and re-run.',
      idx.indisunique, idx.indisvalid, idx.partial, idx.keys;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_messages_session_seq_uniq
  ON evaluation_messages (session_id, sequence);

DROP INDEX IF EXISTS idx_eval_messages_session_seq;

-- Postconditions assert the whole catalog shape this file is responsible for. The ADD COLUMN above
-- cannot fail on its own; the guarded index can, which is why both are checked here rather than
-- assumed from a clean exit.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(item, ', ') INTO missing FROM (
    SELECT 'evaluation_registrations.school_scope_trusted (boolean, NOT NULL, DEFAULT false)' AS item
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'evaluation_registrations'
        AND column_name = 'school_scope_trusted'
        AND data_type = 'boolean'
        AND is_nullable = 'NO'
        AND column_default = 'false'
    )
    UNION ALL
    -- Same four catalog properties the guard above requires, not a rendered-definition regex: a
    -- partial or non-unique index of the right name would otherwise satisfy the postcondition while
    -- leaving transcripts unconstrained.
    SELECT 'unique, valid, unpredicated index idx_eval_messages_session_seq_uniq on exactly (session_id, sequence)'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = 'idx_eval_messages_session_seq_uniq'
        AND i.indrelid = 'public.evaluation_messages'::regclass
        AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
        AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
            = ARRAY['session_id', 'sequence']
    )
  ) AS absent;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'C2 postcondition failed: missing %', missing;
  END IF;
END
$$;
