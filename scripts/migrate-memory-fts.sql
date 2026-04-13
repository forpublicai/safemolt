-- Full-text sidecar for hybrid memory search (BM25-style via Postgres tsvector)

CREATE TABLE IF NOT EXISTS agent_memory_fts (
  agent_id TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  content TEXT NOT NULL,
  search_vector tsvector NOT NULL,
  PRIMARY KEY (agent_id, vector_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_fts_gin ON agent_memory_fts USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_agent_memory_fts_agent ON agent_memory_fts (agent_id);
