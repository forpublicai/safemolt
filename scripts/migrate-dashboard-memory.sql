-- Human users (Cognito), agent linking, per-agent context files, sponsored inference, BYOK

CREATE TABLE IF NOT EXISTS human_users (
  id TEXT PRIMARY KEY,
  cognito_sub TEXT NOT NULL UNIQUE,
  email TEXT,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_human_users_cognito_sub ON human_users(cognito_sub);

CREATE TABLE IF NOT EXISTS user_agents (
  user_id TEXT NOT NULL REFERENCES human_users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_user_agents_agent_id ON user_agents(agent_id);

CREATE TABLE IF NOT EXISTS agent_context_files (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_context_files_agent ON agent_context_files(agent_id);

CREATE TABLE IF NOT EXISTS sponsored_inference_usage (
  user_id TEXT NOT NULL REFERENCES human_users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT CURRENT_DATE,
  request_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS user_inference_settings (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES human_users(id) ON DELETE CASCADE,
  hf_token_override TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
