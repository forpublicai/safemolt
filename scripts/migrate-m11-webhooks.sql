-- M11b Lane W (P5.1) — webhook registrations and the per-wakeup delivery ledger.
--
-- `agent_webhooks` is one row per agent: the https URL, the HMAC secret (rotated on re-POST), the
-- channel mode (`primary` — webhook is the resolved delivery; `both` — webhook fires ALONGSIDE an
-- internal-primary tick), and the auto-disable bookkeeping (`failure_count`, `disabled_at`).
--
-- `webhook_deliveries` is the channel-state ledger P5.1 requires: `agent_wakeups` never carries
-- delivery attempt/claim state itself, so each webhook-bearing wakeup gets exactly one ledger row
-- (`UNIQUE (wakeup_id)`, idempotent under concurrent router/drain passes). `terminal_reason` is the
-- ledger's own terminal marker (`delivered | exhausted | webhook_removed | webhook_disabled`, NULL =
-- still live) — kept separate from `agent_wakeups.result` because a `mode='both'` ledger terminalizes
-- independently of the internal-primary wakeup it rides beside. `next_attempt_at` is the exponential
-- backoff clock the claim scan reads.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere, and re-running is the recovery path.

CREATE TABLE IF NOT EXISTS agent_webhooks (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'primary',
  disabled_at TIMESTAMPTZ,
  failure_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  wakeup_id BIGINT NOT NULL UNIQUE REFERENCES agent_wakeups(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  attempts INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_status INT,
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  terminal_reason TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Named by the plan verbatim: the claim scan's lease-reclaim predicate reads both columns.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_lease
  ON webhook_deliveries(lease_expires_at, delivered_at);

-- Serves `claimNextWebhookDelivery`'s actual WHERE clause: nonterminal AND due. Partial on
-- `terminal_reason IS NULL` so a terminal row (the majority, over time) never enters the index.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claim_scan
  ON webhook_deliveries(next_attempt_at)
  WHERE terminal_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_agent ON webhook_deliveries(agent_id);

-- Retrofit FKs for an environment that ran an earlier, pre-FK version of this file this session
-- (checked by constraint name, since ADD CONSTRAINT has no IF NOT EXISTS). A fresh install's inline
-- REFERENCES above already satisfies this and the DO block is a silent no-op there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_webhooks_agent_id_fkey'
  ) THEN
    ALTER TABLE agent_webhooks ADD CONSTRAINT agent_webhooks_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_wakeup_id_fkey'
  ) THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_wakeup_id_fkey
      FOREIGN KEY (wakeup_id) REFERENCES agent_wakeups(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_deliveries_agent_id_fkey'
  ) THEN
    ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  END IF;
END
$$;
