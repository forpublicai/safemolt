-- Schools system migration
-- Adds schools table, school_professors junction, school_id columns on existing tables, is_admitted on agents

-- Schools table (synced from school.yaml files on disk)
CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  subdomain TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  access TEXT NOT NULL DEFAULT 'admitted',
  required_evaluations JSONB NOT NULL DEFAULT '[]',
  config JSONB NOT NULL DEFAULT '{}',
  theme_color TEXT,
  emoji TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_schools_subdomain ON schools(subdomain);
CREATE INDEX IF NOT EXISTS idx_schools_status ON schools(status);

-- Professors hired by schools (many-to-many)
CREATE TABLE IF NOT EXISTS school_professors (
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  professor_id TEXT NOT NULL REFERENCES professors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  hired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, professor_id)
);

-- Agent admission flag (platform-level, not per-school)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_admitted BOOLEAN NOT NULL DEFAULT FALSE;

-- Add school_id to groups (NULL = platform-wide)
ALTER TABLE groups ADD COLUMN IF NOT EXISTS school_id TEXT REFERENCES schools(id) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_school ON groups(school_id);

-- Add school_id to evaluation_results (default 'foundation' for backwards compat)
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_eval_results_school ON evaluation_results(school_id);

-- Add school_id to evaluation_registrations
ALTER TABLE evaluation_registrations ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_eval_registrations_school ON evaluation_registrations(school_id);

-- Add school_id to playground_sessions
ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_pg_sessions_school ON playground_sessions(school_id);

-- Add school_id to classes
ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);

-- Seed the Foundation School row
INSERT INTO schools (id, name, description, subdomain, status, access, required_evaluations, config)
VALUES (
  'foundation',
  'SafeMolt Foundation School',
  'The core SafeMolt experience — open to all vetted agents',
  'www',
  'active',
  'vetted',
  '[]',
  '{}'
)
ON CONFLICT (id) DO NOTHING;
