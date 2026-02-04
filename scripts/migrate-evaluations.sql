-- Migration for evaluations system
-- Run this after schema.sql has been applied

-- Evaluation definitions are loaded from .md files, but we cache metadata in DB for fast queries
CREATE TABLE IF NOT EXISTS evaluation_definitions (
  id TEXT PRIMARY KEY,
  sip_number INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  module TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  file_path TEXT NOT NULL,
  executable_handler TEXT NOT NULL,
  executable_script_path TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_def_module ON evaluation_definitions(module);
CREATE INDEX IF NOT EXISTS idx_eval_def_status ON evaluation_definitions(status);
CREATE INDEX IF NOT EXISTS idx_eval_def_sip ON evaluation_definitions(sip_number);

-- Prerequisites (many-to-many relationship)
CREATE TABLE IF NOT EXISTS evaluation_prerequisites (
  evaluation_id TEXT NOT NULL REFERENCES evaluation_definitions(id) ON DELETE CASCADE,
  prerequisite_id TEXT NOT NULL REFERENCES evaluation_definitions(id) ON DELETE CASCADE,
  PRIMARY KEY (evaluation_id, prerequisite_id)
);

-- Agent registrations for evaluations
CREATE TABLE IF NOT EXISTS evaluation_registrations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES evaluation_definitions(id) ON DELETE CASCADE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'registered',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_eval_reg_agent ON evaluation_registrations(agent_id);
CREATE INDEX IF NOT EXISTS idx_eval_reg_eval ON evaluation_registrations(evaluation_id);
CREATE INDEX IF NOT EXISTS idx_eval_reg_status ON evaluation_registrations(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_reg_active ON evaluation_registrations(agent_id, evaluation_id) 
  WHERE status IN ('registered', 'in_progress');

-- Evaluation results
CREATE TABLE IF NOT EXISTS evaluation_results (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES evaluation_registrations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES evaluation_definitions(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  score INTEGER,
  max_score INTEGER,
  result_data JSONB,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proctor_agent_id TEXT REFERENCES agents(id),
  proctor_feedback TEXT
);

CREATE INDEX IF NOT EXISTS idx_eval_results_agent ON evaluation_results(agent_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_eval ON evaluation_results(evaluation_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_passed ON evaluation_results(passed);
CREATE INDEX IF NOT EXISTS idx_eval_results_registration ON evaluation_results(registration_id);

-- Live class work participants (for shared grades)
CREATE TABLE IF NOT EXISTS evaluation_participants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES evaluation_registrations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES evaluation_definitions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_participants_session ON evaluation_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_eval_participants_agent ON evaluation_participants(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_participants_unique ON evaluation_participants(agent_id, session_id);
