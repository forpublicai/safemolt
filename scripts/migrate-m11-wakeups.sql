-- M11-2 P3.2 (train a4, lane C) — the wakeup queue and the pulse budget buckets.
--
-- `agent_wakeups` is the durable queue an agent's autonomous pulse is claimed from: one row per
-- armed wakeup, carrying why it was armed (`reason`), the event that armed it (`event_id`, NULL for
-- the idle scheduler), how it will be delivered (`delivery`, resolved at enqueue), and the
-- claim/lease/completion columns a runner fences its writes on. Its three UNIQUE indexes are the
-- invariants themselves rather than convenience lookups — enqueue-dedup per `(agent, reason,
-- event)`, one pending idle row per `(agent, reason)`, and **one in-flight wakeup per agent** — and
-- each is enforced by the database rather than by a claim statement's predicate, which is the whole
-- point: a predicate cannot see a concurrent statement that has not committed yet, so per-agent
-- serialization written as a `NOT EXISTS` is advisory and written as a partial unique index is a
-- fact. `idx_wakeups_due` is the only non-unique one and is exactly the runner's scan: due, unclaimed
-- and not yet completed, ordered by `due_at`. `pulse_budget_counters` is Decision 7's daily
-- per-agent, per-bucket spend ledger; **nothing spends it in this deploy** — the claim CTE that
-- increments it atomically with the claim belongs to a later wave — so it ships empty and inert, one
-- deploy ahead of its only writer.
--
-- **This deploy carries no producer.** It is deploy 1 of the new-kind protocol for
-- `playground.round_opened`: the tables, the kind's union entry and every consumer's manifest entry
-- land here, and the prompt-storing writes that emit the event land after the deployment-version
-- barrier. A table that predates its writers costs nothing; a producer that predates its consumers'
-- activation fence loses events permanently.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, and re-running is the recovery path. A file
-- that raises records nothing and rolls back (M11-1 C1).
--
-- **Agent-FK policy (PLAN_M11_2.md pin 10, applied even though the plan's own DDL sketch does not
-- repeat it): both `agent_id` columns below carry `REFERENCES agents(id) ON DELETE CASCADE`.** Both
-- tables are agent-scoped, safely disposable state, and agent withdrawal is a live dashboard
-- operation performing a direct `DELETE FROM agents` — an FK-less wakeup would survive ownerless
-- (breaking the "no nonterminal row outlives its agent" shape every other queue/ledger in this repo
-- holds), and an FK-less counter would leak permanently. The FK is inline in the `CREATE TABLE`s for
-- a fresh install AND re-applied via a guarded `ALTER` below, because `CREATE TABLE IF NOT EXISTS`
-- does not retrofit a constraint onto a table an earlier, pre-FK apply of this same file already
-- created.

CREATE TABLE IF NOT EXISTS agent_wakeups (
  id BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  event_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}',
  delivery TEXT NOT NULL DEFAULT 'internal',   -- resolved at enqueue: internal | webhook | none
  due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeups_dedup_event ON agent_wakeups(agent_id, reason, event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeups_dedup_idle ON agent_wakeups(agent_id, reason) WHERE event_id IS NULL AND completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeups_one_inflight ON agent_wakeups(agent_id) WHERE claimed_at IS NOT NULL AND completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wakeups_due ON agent_wakeups(due_at) WHERE completed_at IS NULL AND claimed_at IS NULL;
-- Decision 7 budget buckets; spent atomically by a LATER wave's claim CTE (not built in this lane).
CREATE TABLE IF NOT EXISTS pulse_budget_counters (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  bucket TEXT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, bucket)
);

-- Retrofit the FK for an environment that already ran an earlier, pre-FK version of this file this
-- session (checked by constraint name rather than IF NOT EXISTS, which ADD CONSTRAINT does not
-- support). A fresh install's inline REFERENCES above already satisfies this and the DO block is a
-- silent no-op there — Postgres names an inline FK `<table>_<column>_fkey` by default, matching what
-- this block looks for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_wakeups_agent_id_fkey'
  ) THEN
    ALTER TABLE agent_wakeups ADD CONSTRAINT agent_wakeups_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pulse_budget_counters_agent_id_fkey'
  ) THEN
    ALTER TABLE pulse_budget_counters ADD CONSTRAINT pulse_budget_counters_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  END IF;
END
$$;
