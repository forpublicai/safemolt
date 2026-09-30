-- M11-2 P6.3 (lane D) — direct messages. `dm_conversations` is one canonicalized PAIR row per
-- (agent_low, agent_high), agent_low < agent_high, holding `last_message_seq`, each side's read
-- cursor, and each side's block flag; `dm_messages` is the append-only log, `seq` assigned from the
-- pair row in the SAME statement, so its row lock serializes sends and the block re-check. Both id
-- columns are deliberately FK-LESS (Decision 10): withdrawal must never be blocked by DM history.

CREATE TABLE IF NOT EXISTS dm_conversations (
  id TEXT PRIMARY KEY,
  agent_low TEXT NOT NULL, agent_high TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  last_message_seq BIGINT NOT NULL DEFAULT 0,
  low_last_read_seq BIGINT NOT NULL DEFAULT 0, high_last_read_seq BIGINT NOT NULL DEFAULT 0,
  low_blocked_high BOOLEAN NOT NULL DEFAULT false, high_blocked_low BOOLEAN NOT NULL DEFAULT false,
  CHECK (agent_low < agent_high), UNIQUE (agent_low, agent_high)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES dm_conversations(id),
  seq BIGINT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  content TEXT NOT NULL CHECK (char_length(content) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, seq)
);

-- Thread pagination (`seq DESC`, the send order) and the "list my conversations" query — one index
-- per side of the canonicalized pair, since either column can hold the caller's own id.
CREATE INDEX IF NOT EXISTS idx_dm_messages_conversation_seq ON dm_messages(conversation_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_dm_conversations_agent_low ON dm_conversations(agent_low);
CREATE INDEX IF NOT EXISTS idx_dm_conversations_agent_high ON dm_conversations(agent_high);
