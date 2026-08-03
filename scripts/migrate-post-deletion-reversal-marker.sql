-- M11-1b D1 (finding 1) — mark the tombstones whose karma reversal actually ran.
--
-- D1's delete reverses exactly what a post's votes awarded, using the `points_delta` M11-1C
-- records. The reconciliation sweep could not do the same for posts deleted by an OLD instance
-- during the rollout: a new instance records a real delta, an old instance then tombstones without
-- reversing, and the runtime reversal can never reach that post again because every anchor in the
-- delete requires `deleted_at IS NULL`. The sweep assumed every vote on an already-deleted post
-- predated M11-1C and carried a NULL delta, which is exactly false inside that window.
--
-- This column is the marker that tells the two cases apart. It is written by the SAME statement
-- that writes `deleted_at`, and only by a delete that also ran the reversal. So:
--   deleted_at IS NOT NULL AND deleted_karma_reversed_at IS NULL  ->  reversal never ran here.
-- That is the sweep's predicate, and the sweep sets the marker as it repairs, which is what makes
-- a second pass report zero.
--
-- Backfill is deliberately absent: every post already tombstoned when this migration runs is a
-- post whose reversal did not run, which is precisely what a NULL marker states. Pre-M11-1C
-- deletions have nothing to give back (their votes carry NULL deltas), and the sweep will find
-- that, reverse nothing, and mark them.
--
-- Idempotent; re-running is the recovery path.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_karma_reversed_at TIMESTAMPTZ;

-- **No index, deliberately.** A partial index on the unreversed tombstones would help the sweep's
-- scan, but building it here would not be free: this file runs during the BUILD, while the previous
-- instances are still serving, and a plain `CREATE INDEX` takes a SHARE lock that blocks every
-- insert, vote, comment counter and delete on `posts` until the scan finishes. `CONCURRENTLY` is
-- not available either — the runner executes a file as one implicit transaction, and
-- `CREATE INDEX CONCURRENTLY` cannot run inside one. The scan it would serve belongs to a runbook
-- script that is run by hand, rarely, and can afford a sequential scan; stalling live writes during
-- a deploy to speed it up is the wrong trade.

-- Postcondition: the column exists and no LIVE post carries the marker. A live post with a
-- reversal timestamp would mean a delete set the marker without the tombstone, which is the one
-- pairing the delete statement must never produce.
DO $$
DECLARE
  mismatched INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'posts' AND column_name = 'deleted_karma_reversed_at'
  ) THEN
    RAISE EXCEPTION 'posts.deleted_karma_reversed_at missing after migration';
  END IF;

  SELECT count(*) INTO mismatched
  FROM posts
  WHERE deleted_at IS NULL AND deleted_karma_reversed_at IS NOT NULL;

  IF mismatched > 0 THEN
    RAISE EXCEPTION 'posts: % live row(s) carry deleted_karma_reversed_at', mismatched;
  END IF;
END $$;
