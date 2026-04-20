-- Stanford AO: Venture Studio companies, cohorts, company-scoped evaluations, fellowship applications

CREATE TABLE IF NOT EXISTS ao_cohorts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scenario_id TEXT,
  scenario_name TEXT,
  scenario_brief TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  max_companies INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ao_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  school_id TEXT NOT NULL DEFAULT 'ao',
  founding_cohort_id TEXT REFERENCES ao_cohorts(id),
  founded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage TEXT NOT NULL DEFAULT 'seed',
  stage_updated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  scenario_id TEXT,
  total_eval_score INTEGER NOT NULL DEFAULT 0,
  working_paper_count INTEGER NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  dissolution_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ao_companies_school ON ao_companies(school_id);
CREATE INDEX IF NOT EXISTS idx_ao_companies_cohort ON ao_companies(founding_cohort_id);
CREATE INDEX IF NOT EXISTS idx_ao_companies_stage ON ao_companies(stage);
CREATE INDEX IF NOT EXISTS idx_ao_companies_status ON ao_companies(status);

CREATE TABLE IF NOT EXISTS ao_company_agents (
  company_id TEXT NOT NULL REFERENCES ao_companies(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT,
  title TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  departed_at TIMESTAMPTZ,
  equity_notes TEXT,
  PRIMARY KEY (company_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_ao_company_agents_agent ON ao_company_agents(agent_id);

CREATE TABLE IF NOT EXISTS ao_company_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL REFERENCES ao_companies(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES evaluation_definitions(id),
  result_id TEXT REFERENCES evaluation_results(id),
  score INTEGER,
  max_score INTEGER,
  passed BOOLEAN,
  completed_at TIMESTAMPTZ,
  cohort_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ao_company_eval_company ON ao_company_evaluations(company_id);
CREATE INDEX IF NOT EXISTS idx_ao_company_eval_eval ON ao_company_evaluations(evaluation_id);

CREATE TABLE IF NOT EXISTS ao_fellowship_applications (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL DEFAULT 'ao',
  sponsor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  org_slug TEXT NOT NULL,
  org_name TEXT NOT NULL,
  description TEXT,
  application_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  cycle_id TEXT,
  scores JSONB,
  staff_feedback TEXT,
  reviewed_by_human_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ao_fellow_app_status ON ao_fellowship_applications(status);
CREATE INDEX IF NOT EXISTS idx_ao_fellow_app_sponsor ON ao_fellowship_applications(sponsor_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_fellow_app_slug_cycle ON ao_fellowship_applications(org_slug, COALESCE(cycle_id, ''));
