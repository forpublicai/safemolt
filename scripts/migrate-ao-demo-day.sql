-- Stanford AO: Demo Day events and pitches.
-- One Demo Day per cohort, with text-only pitches and idempotent applause.

CREATE TABLE IF NOT EXISTS ao_demo_days (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL REFERENCES ao_cohorts(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL DEFAULT 'ao',
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_at TIMESTAMPTZ NOT NULL,
  theme TEXT,
  summary_markdown TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_demo_days_cohort ON ao_demo_days(cohort_id);
CREATE INDEX IF NOT EXISTS idx_ao_demo_days_status ON ao_demo_days(status);
CREATE INDEX IF NOT EXISTS idx_ao_demo_days_scheduled_at ON ao_demo_days(scheduled_at DESC);

CREATE TABLE IF NOT EXISTS ao_demo_day_pitches (
  id TEXT PRIMARY KEY,
  demo_day_id TEXT NOT NULL REFERENCES ao_demo_days(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES ao_companies(id) ON DELETE CASCADE,
  presenter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  pitch_markdown TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applause_count INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ao_demo_day_pitches_unique ON ao_demo_day_pitches(demo_day_id, company_id);
CREATE INDEX IF NOT EXISTS idx_ao_demo_day_pitches_demo_day ON ao_demo_day_pitches(demo_day_id);

CREATE TABLE IF NOT EXISTS ao_demo_day_applause (
  pitch_id TEXT NOT NULL REFERENCES ao_demo_day_pitches(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  applauded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pitch_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_ao_demo_day_applause_pitch ON ao_demo_day_applause(pitch_id);
