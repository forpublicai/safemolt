-- Repair classes/schools base schema for databases that recorded earlier
-- classes-dependent migrations while the base classes tables were absent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS professors (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  api_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  professor_id TEXT NOT NULL REFERENCES professors(id),
  name TEXT NOT NULL,
  description TEXT,
  syllabus JSONB,
  status TEXT NOT NULL DEFAULT 'draft',
  enrollment_open BOOLEAN DEFAULT false,
  max_students INTEGER,
  hidden_objective TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS class_assistants (
  class_id TEXT NOT NULL REFERENCES classes(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (class_id, agent_id)
);

CREATE TABLE IF NOT EXISTS class_enrollments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  class_id TEXT NOT NULL REFERENCES classes(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'enrolled',
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (class_id, agent_id)
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  class_id TEXT NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'lecture',
  content TEXT,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_session_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES class_sessions(id),
  sender_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_evaluations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  class_id TEXT NOT NULL REFERENCES classes(id),
  title TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,
  taught_topic TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  max_score REAL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS class_evaluation_results (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  evaluation_id TEXT NOT NULL REFERENCES class_evaluations(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  response TEXT,
  score REAL,
  max_score REAL,
  result_data JSONB,
  feedback TEXT,
  completed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (evaluation_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_classes_professor ON classes(professor_id);
CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status);
CREATE INDEX IF NOT EXISTS idx_class_enrollments_class ON class_enrollments(class_id);
CREATE INDEX IF NOT EXISTS idx_class_enrollments_agent ON class_enrollments(agent_id);
CREATE INDEX IF NOT EXISTS idx_class_sessions_class ON class_sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_class_session_messages_session ON class_session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_class_evaluations_class ON class_evaluations(class_id);
CREATE INDEX IF NOT EXISTS idx_class_evaluation_results_eval ON class_evaluation_results(evaluation_id);

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

CREATE TABLE IF NOT EXISTS school_professors (
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  professor_id TEXT NOT NULL REFERENCES professors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  hired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_id, professor_id)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_admitted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE groups ADD COLUMN IF NOT EXISTS school_id TEXT REFERENCES schools(id) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_school ON groups(school_id);

ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_eval_results_school ON evaluation_results(school_id);

ALTER TABLE evaluation_registrations ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_eval_registrations_school ON evaluation_registrations(school_id);

ALTER TABLE playground_sessions ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_pg_sessions_school ON playground_sessions(school_id);

ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_id TEXT DEFAULT 'foundation';
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(school_id);

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

ALTER TABLE professors ADD COLUMN IF NOT EXISTS human_user_id TEXT REFERENCES human_users(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_professors_human_user ON professors(human_user_id) WHERE human_user_id IS NOT NULL;

ALTER TABLE classes ADD COLUMN IF NOT EXISTS slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_slug_unique ON classes(slug);
CREATE INDEX IF NOT EXISTS idx_classes_slug ON classes(slug);

CREATE TABLE IF NOT EXISTS class_slug_aliases (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_class_slug_aliases_class_id ON class_slug_aliases(class_id);

WITH class_slug_bases AS (
  SELECT
    c.id,
    COALESCE(
      NULLIF(
        TRIM(BOTH '-' FROM regexp_replace(lower(c.name), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'class'
    ) AS base_slug,
    c.created_at
  FROM classes c
),
class_slug_ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (PARTITION BY base_slug ORDER BY created_at, id) AS slug_rank
  FROM class_slug_bases
)
UPDATE classes c
SET slug = CASE
  WHEN r.slug_rank = 1 THEN r.base_slug
  ELSE r.base_slug || '-' || r.slug_rank::text
END
FROM class_slug_ranked r
WHERE c.id = r.id
  AND (c.slug IS NULL OR c.slug = '');

ALTER TABLE classes ALTER COLUMN slug SET NOT NULL;

DO $$
DECLARE
  rec RECORD;
  new_id TEXT;
  temp_slug TEXT;
BEGIN
  FOR rec IN
    SELECT id, slug
    FROM classes
    WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  LOOP
    new_id := gen_random_uuid()::text;
    temp_slug := rec.slug || '-migrating-' || substring(new_id from 1 for 8);

    INSERT INTO classes (
      id, slug, professor_id, name, description, syllabus, status, enrollment_open,
      max_students, hidden_objective, created_at, started_at, ended_at, school_id
    )
    SELECT
      new_id,
      temp_slug,
      c.professor_id,
      c.name,
      c.description,
      c.syllabus,
      c.status,
      c.enrollment_open,
      c.max_students,
      c.hidden_objective,
      c.created_at,
      c.started_at,
      c.ended_at,
      c.school_id
    FROM classes c
    WHERE c.id = rec.id;

    UPDATE class_assistants SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_enrollments SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_sessions SET class_id = new_id WHERE class_id = rec.id;
    UPDATE class_evaluations SET class_id = new_id WHERE class_id = rec.id;

    INSERT INTO class_slug_aliases (class_id, old_slug)
    VALUES (new_id, rec.id)
    ON CONFLICT (old_slug) DO NOTHING;

    DELETE FROM classes WHERE id = rec.id;
    UPDATE classes SET slug = rec.slug WHERE id = new_id;
  END LOOP;
END $$;
