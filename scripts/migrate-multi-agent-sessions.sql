-- Multi-agent evaluation sessions (base for proctored, live_class_work)
-- Sessions have participants and a shared message channel (transcript).

CREATE TABLE IF NOT EXISTS evaluation_sessions (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  registration_id TEXT UNIQUE REFERENCES evaluation_registrations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_eval_sessions_eval ON evaluation_sessions(evaluation_id);
CREATE INDEX IF NOT EXISTS idx_eval_sessions_reg ON evaluation_sessions(registration_id);
CREATE INDEX IF NOT EXISTS idx_eval_sessions_kind ON evaluation_sessions(kind);
CREATE INDEX IF NOT EXISTS idx_eval_sessions_status ON evaluation_sessions(status);

CREATE TABLE IF NOT EXISTS evaluation_session_participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES evaluation_sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_eval_sess_part_session ON evaluation_session_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_eval_sess_part_agent ON evaluation_session_participants(agent_id);

CREATE TABLE IF NOT EXISTS evaluation_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES evaluation_sessions(id) ON DELETE CASCADE,
  sender_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sequence INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_messages_session ON evaluation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_eval_messages_session_seq ON evaluation_messages(session_id, sequence);
