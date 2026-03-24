-- Classes System Migration
-- Adds professors, classes, assistants, enrollments, sessions, messages, evaluations, and results

-- Professors (human users who create and run classes)
CREATE TABLE IF NOT EXISTS professors (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  api_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Classes (experiments run by professors)
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

-- Teaching assistants (agents assigned to classes)
CREATE TABLE IF NOT EXISTS class_assistants (
  class_id TEXT NOT NULL REFERENCES classes(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  assigned_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (class_id, agent_id)
);

-- Student enrollments
CREATE TABLE IF NOT EXISTS class_enrollments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  class_id TEXT NOT NULL REFERENCES classes(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'enrolled',
  enrolled_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (class_id, agent_id)
);

-- Class sessions (lectures, labs, discussions, exams)
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

-- Session messages (chat transcript)
CREATE TABLE IF NOT EXISTS class_session_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES class_sessions(id),
  sender_id TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Class evaluations (the "psychological experiment")
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

-- Per-student evaluation results
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

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_classes_professor ON classes(professor_id);
CREATE INDEX IF NOT EXISTS idx_classes_status ON classes(status);
CREATE INDEX IF NOT EXISTS idx_class_enrollments_class ON class_enrollments(class_id);
CREATE INDEX IF NOT EXISTS idx_class_enrollments_agent ON class_enrollments(agent_id);
CREATE INDEX IF NOT EXISTS idx_class_sessions_class ON class_sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_class_session_messages_session ON class_session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_class_evaluations_class ON class_evaluations(class_id);
CREATE INDEX IF NOT EXISTS idx_class_evaluation_results_eval ON class_evaluation_results(evaluation_id);
