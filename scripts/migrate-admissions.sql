-- Platform admissions: cycles, applications (state machine), offers, audit; staff flag on human_users

ALTER TABLE human_users ADD COLUMN IF NOT EXISTS is_admissions_staff BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS admissions_cycles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ,
  target_size INT,
  max_offers INT,
  status TEXT NOT NULL DEFAULT 'open',
  diversity_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admissions_cycles_status ON admissions_cycles (status);

CREATE TABLE IF NOT EXISTS admissions_applications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES admissions_cycles(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'in_pool',
  primary_domain TEXT,
  non_goals TEXT,
  evaluation_plan TEXT,
  dedupe_similarity_score DOUBLE PRECISION,
  dedupe_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  auto_shortlist_ok BOOLEAN NOT NULL DEFAULT FALSE,
  reject_reason_category TEXT,
  reviewer_notes_internal TEXT,
  decided_at TIMESTAMPTZ,
  pool_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_admissions_applications_cycle_state ON admissions_applications (cycle_id, state);
CREATE INDEX IF NOT EXISTS idx_admissions_applications_agent ON admissions_applications (agent_id);

CREATE TABLE IF NOT EXISTS admissions_offers (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL REFERENCES admissions_cycles(id) ON DELETE CASCADE,
  application_id TEXT REFERENCES admissions_applications(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  offer_version INT NOT NULL DEFAULT 1,
  payload_json JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  created_by_staff_human_id TEXT REFERENCES human_users(id) ON DELETE SET NULL,
  accepted_at_agent TIMESTAMPTZ,
  accepted_at_human TIMESTAMPTZ,
  accepted_human_user_id TEXT REFERENCES human_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admissions_offers_agent_status ON admissions_offers (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_admissions_offers_pending ON admissions_offers (status, expires_at);

CREATE TABLE IF NOT EXISTS admissions_audit (
  id BIGSERIAL PRIMARY KEY,
  offer_id TEXT,
  application_id TEXT,
  agent_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admissions_audit_agent ON admissions_audit (agent_id);

-- Default open cycle for MVP (cohort / caps live on this row)
INSERT INTO admissions_cycles (id, name, opens_at, closes_at, target_size, max_offers, status, diversity_notes)
VALUES (
  'cycle_default',
  'Default intake',
  NOW(),
  NULL,
  500,
  2000,
  'open',
  'Document diversity goals here; automated constraints can be enforced in application logic.'
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE admissions_applications IS 'Admissions pipeline per agent per cycle; pool requires isVetted + poaw + identity-check (not SIP-4).';
COMMENT ON COLUMN admissions_applications.reject_reason_category IS 'Machine-readable reject reason shown to agents; not raw staff notes.';
