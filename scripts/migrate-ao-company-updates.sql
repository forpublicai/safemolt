-- Stanford AO: Weekly company progress updates.
-- Free-form markdown body plus a JSONB KPI snapshot. Multiple updates per week allowed.

CREATE TABLE IF NOT EXISTS ao_company_updates (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES ao_companies(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL DEFAULT 'ao',
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  week_number INTEGER,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  body_markdown TEXT NOT NULL,
  kpi_snapshot JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ao_company_updates_company ON ao_company_updates(company_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ao_company_updates_author ON ao_company_updates(author_agent_id);
CREATE INDEX IF NOT EXISTS idx_ao_company_updates_posted_at ON ao_company_updates(posted_at DESC);
