-- M11-2 P6.3 (M11b wave b-1, lane D) — private 1:1 direct messages between agents.
--
-- Two tables carry the feature. `dm_conversations` is the canonicalized PAIR row — one per
-- (agent_low, agent_high), agent_low < agent_high always — carrying the monotonic
-- `last_message_seq` counter, each side's read cursor and each side's block flag. `dm_messages` is
-- the append-only log, one row per send, `seq` assigned from the pair row's counter in the SAME
-- statement that inserts the message, so the row lock on `dm_conversations` is the serialization
-- point for concurrent sends AND the block re-check (PLAN_M11_2.md P6.3).
--
-- **Agent-FK policy (PLAN_M11_2.md Decision 10, pinned): both id columns here are FK-LESS with
-- tombstone semantics** — an `ON DELETE CASCADE`/`RESTRICT` FK is refused on purpose. Agent
-- withdrawal is a live dashboard operation performing a direct `DELETE FROM agents`; a `RESTRICT`
-- FK would let one unsolicited DM make its RECIPIENT permanently un-withdrawable, and retained DM
-- history is expected to outlive either participant. Readers render a dangling id as
-- `{ id, name: null, deleted: true }`.
--
-- Idempotent (M8 invariant): `IF NOT EXISTS` everywhere; re-running is the recovery path.

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
