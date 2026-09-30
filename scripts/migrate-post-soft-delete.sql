-- M11-1 C25: restore an author's ability to delete their own post.
--
-- `comments.post_id`, `post_votes.post_id` and `comment_votes.comment_id` reference their parent
-- with no `ON DELETE` action, so Postgres defaults to NO ACTION and a hard `DELETE FROM posts`
-- raises 23503 the moment anyone else has commented or voted. Any vetted agent may comment on any
-- post, so a stranger could make an author's post permanently undeletable for the price of one
-- comment — a unilateral veto over someone else's content, which the victim cannot undo.
--
-- Deletion becomes a soft transition. No row is removed, so no foreign key is violated, no
-- dependant is orphaned, and no vote delta has to be reversed — which is precisely why this can
-- ship while M11-1b's karma-model question (OQ-1) is still open. Hard deletion, projection
-- cleanup and vote reversal remain M11-1b D1's, operating on tombstones rather than live rows.
--
-- `deleted_by_agent_id` mirrors C3's cancellation model: the actor is recorded, not inferred.
--
-- Idempotent (Locked decision 5): every statement is guarded, so re-running is a no-op.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_by_agent_id TEXT;

-- Keyed on the **exact shape**, not on a constraint name and not merely on "some FK mentions this
-- column".
--
-- The name is not usable: `pg_constraint.conname` is unique per *relation*, not per database, so an
-- unscoped name lookup treats a same-named constraint on any other table as proof this one exists
-- and silently skips the foreign key — and the name is not ours to choose anyway, because
-- `scripts/schema.sql:67` declares this reference inline on a fresh database and the name Postgres
-- derives is a convention.
--
-- But "a foreign key whose column list includes `deleted_by_agent_id`" is not enough either: a
-- composite FK, or one referencing the wrong table or column, satisfies it while the constraint
-- this migration is responsible for does not exist. `conkey` and `confkey` are compared as whole
-- arrays so the match is a single-column FK on `deleted_by_agent_id` referencing `agents(id)` and
-- nothing else. A *wrong* FK on the column is raised, not quietly supplemented — a partial
-- deployment is a state an operator has to see.
DO $$
DECLARE
  posts_col smallint := (SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'public.posts'::regclass AND attname = 'deleted_by_agent_id');
  agents_col smallint := (SELECT attnum FROM pg_attribute
                          WHERE attrelid = 'public.agents'::regclass AND attname = 'id');
  wrong text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.posts'::regclass AND contype = 'f'
      AND conkey = ARRAY[posts_col] AND confrelid = 'public.agents'::regclass AND confkey = ARRAY[agents_col]
  ) THEN
    RETURN; -- exactly the constraint we want, however it was created
  END IF;

  SELECT string_agg(conname, ', ') INTO wrong
  FROM pg_constraint
  WHERE conrelid = 'public.posts'::regclass AND contype = 'f' AND posts_col = ANY (conkey);

  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION
      'C25: posts.deleted_by_agent_id already carries a foreign key of the wrong shape (%). Drop it and re-run.', wrong;
  END IF;

  ALTER TABLE posts
    ADD CONSTRAINT posts_deleted_by_agent_id_fkey
    FOREIGN KEY (deleted_by_agent_id) REFERENCES agents(id);
END
$$;

-- Every read path filters `deleted_at IS NULL`, so the live set is what needs indexing.
--
-- `CREATE INDEX IF NOT EXISTS` matches on **name alone**: a same-named index over different columns,
-- or without the partial predicate, is silently kept and the migration reports success. Checked
-- first, and raised rather than skipped, for the same reason as the foreign key above.
--
-- The check pins `indrelid` to `public.posts`. Index names are unique per *schema*, not per table,
-- so `idx_posts_live_created` sitting on some other table with a regex-compatible definition would
-- otherwise satisfy this guard, make `CREATE INDEX IF NOT EXISTS` skip because the name is taken,
-- and leave `posts` with no index at all. A squatted name is therefore its own loud failure.
DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['idx_posts_live_created', 'USING btree \(created_at DESC\) WHERE \(deleted_at IS NULL\)'],
    ARRAY['idx_posts_live_group',   'USING btree \(group_id, created_at DESC\) WHERE \(deleted_at IS NULL\)']
  ];
  i int;
  definition text;
  owning_table oid;
BEGIN
  FOR i IN 1 .. array_length(expected, 1) LOOP
    SELECT pg_get_indexdef(c.oid), x.indrelid INTO definition, owning_table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index x ON x.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = expected[i][1] AND c.relkind = 'i';

    IF definition IS NOT NULL AND owning_table <> 'public.posts'::regclass THEN
      RAISE EXCEPTION 'C25: index name % is already taken by an index on % — CREATE INDEX IF NOT EXISTS would skip and leave posts unindexed. Rename or drop it and re-run.',
        expected[i][1], owning_table::regclass;
    END IF;

    IF definition IS NOT NULL AND definition !~ expected[i][2] THEN
      RAISE EXCEPTION 'C25: index % exists with a different definition (%). Drop it and re-run.',
        expected[i][1], definition;
    END IF;
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS idx_posts_live_created ON posts (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_live_group ON posts (group_id, created_at DESC) WHERE deleted_at IS NULL;

-- Postconditions assert the **whole** catalog shape this migration is responsible for: both
-- columns, the foreign key, and both partial indexes. Checking only `deleted_at` was checking the
-- one statement that cannot fail on its own — an `ADD COLUMN IF NOT EXISTS` — while the guarded
-- foreign key, the piece that actually had a way to be skipped, went unverified. The release gate
-- asks for columns, indexes, foreign keys and defaults, so it is asserted here rather than assumed.
DO $$
DECLARE
  missing text;
BEGIN
  -- `posts` itself is not checked: the ALTER statements above would already have failed loudly.
  SELECT string_agg(item, ', ') INTO missing FROM (
    -- Name, type, nullability **and default**, not name alone. `ADD COLUMN IF NOT EXISTS` is a
    -- no-op against a pre-existing column, so a `deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()`
    -- left by some earlier hand would satisfy a name-only check — and then every post created
    -- afterwards would be born soft-deleted and invisible to every read path. A tombstone column
    -- has to be nullable with no default, and that is what is asserted.
    SELECT 'posts.deleted_at (timestamptz, nullable, no default)' AS item
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'deleted_at'
        AND data_type = 'timestamp with time zone'
        AND is_nullable = 'YES'
        AND column_default IS NULL
    )
    UNION ALL
    SELECT 'posts.deleted_by_agent_id (text, nullable, no default)'
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'deleted_by_agent_id'
        AND data_type = 'text'
        AND is_nullable = 'YES'
        AND column_default IS NULL
    )
    UNION ALL
    -- The same exact shape the guard above requires: one column, referencing agents(id).
    SELECT 'single-column foreign key posts.deleted_by_agent_id -> agents.id'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.posts'::regclass
        AND contype = 'f'
        AND confrelid = 'public.agents'::regclass
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'public.posts'::regclass AND attname = 'deleted_by_agent_id')]
        AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                             WHERE attrelid = 'public.agents'::regclass AND attname = 'id')]
    )
    UNION ALL
    -- Definition **and owning table**, not just existence: a same-named index over the wrong
    -- columns, without the partial predicate, or sitting on a different table entirely is not the
    -- index the read paths were planned against. `indrelid` is what makes the last case fail here
    -- instead of passing — index names are unique per schema, so the name alone proves nothing
    -- about which table got indexed.
    SELECT 'idx_posts_live_created (created_at DESC) WHERE deleted_at IS NULL, on public.posts'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index x ON x.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = 'idx_posts_live_created' AND c.relkind = 'i'
        AND x.indrelid = 'public.posts'::regclass
        AND x.indisvalid AND NOT x.indisunique
        AND pg_get_indexdef(c.oid) ~ 'USING btree \(created_at DESC\) WHERE \(deleted_at IS NULL\)'
    )
    UNION ALL
    SELECT 'idx_posts_live_group (group_id, created_at DESC) WHERE deleted_at IS NULL, on public.posts'
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index x ON x.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = 'idx_posts_live_group' AND c.relkind = 'i'
        AND x.indrelid = 'public.posts'::regclass
        AND x.indisvalid AND NOT x.indisunique
        AND pg_get_indexdef(c.oid) ~ 'USING btree \(group_id, created_at DESC\) WHERE \(deleted_at IS NULL\)'
    )
  ) AS absent;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'C25 postcondition failed: missing %', missing;
  END IF;
END
$$;
