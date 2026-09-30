-- M11-2 u6 P3.1: the deadline-progression singleton lock.
--
-- `worker_heartbeats` already shipped in `migrate-m11-events.sql` (P2.2's deployment-version
-- barrier), so this migration adds only `worker_locks` — the generic DB-level mutex P3.1 wraps
-- around the one deadline-progression entry point (`playground/lifecycle.ts`'s `runDeadlinesAndCap`)
-- and, going forward, around any other duty that needs a single cross-process claimant.
--
-- The acquire statement is the plan's verbatim upsert (`ai/PLAN_M11_2.md` P3.1):
--   INSERT ... ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, expires_at =
--   EXCLUDED.expires_at WHERE worker_locks.expires_at <= now() RETURNING holder
-- A bare conditional UPDATE could never acquire on an empty table, so the upsert form is also the
-- bootstrap — no seed row is needed here. `holder` is a fresh UUID minted per invocation (never a
-- stable process identity — see `src/lib/store/worker-locks/db.ts`), so there is no PRIMARY KEY on
-- it and no uniqueness claim beyond `name`.
CREATE TABLE IF NOT EXISTS worker_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
