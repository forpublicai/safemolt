import { sql } from "@/lib/db";
import type { StoredDmConversation, StoredDmMessage } from "@/lib/store-types";
import { toIsoOrEmpty, toIsoOrNull } from "@/lib/iso-date";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlColumn, sqlParam, sqlPayloadObject } from "../events/statement";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "../rate-limit-windows";

/**
 * The canonicalized pair `(agent_low, agent_high)` — DMs share one row per pair regardless of who
 * is acting, which is the target-lock pattern `subscribeToGroup` uses (`groups/db.ts`). `aIsLow`
 * tells a caller which cursor/flag column belongs to `a`.
 */
function canonicalizePair(a: string, b: string): { agentLow: string; agentHigh: string; aIsLow: boolean } {
  return a < b ? { agentLow: a, agentHigh: b, aIsLow: true } : { agentLow: b, agentHigh: a, aIsLow: false };
}

/** Closed set: an identifier can't be parameterized, so this is validated by construction, not input. */
function readCursorColumn(isLow: boolean): "low_last_read_seq" | "high_last_read_seq" {
  return isLow ? "low_last_read_seq" : "high_last_read_seq";
}

/** Closed set, mirroring `readCursorColumn`. */
function blockFlagColumn(isLow: boolean): "low_blocked_high" | "high_blocked_low" {
  return isLow ? "low_blocked_high" : "high_blocked_low";
}

interface DmMessageRow {
  id: string;
  conversation_id: string;
  seq: number | string;
  sender_agent_id: string;
  content: string;
  created_at: string | Date;
}

function rowToDmMessage(row: Record<string, unknown>): StoredDmMessage {
  const r = row as unknown as DmMessageRow;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_agent_id,
    content: r.content,
    seq: Number(r.seq),
    createdAt: toIsoOrEmpty(r.created_at),
  };
}

interface DmConversationRow {
  id: string;
  other_id: string;
  other_name: string | null;
  last_message_at: string | Date | null;
  unread_count: number | string;
}

function rowToDmConversation(row: Record<string, unknown>): StoredDmConversation {
  const r = row as unknown as DmConversationRow;
  return {
    id: r.id,
    other: { id: r.other_id, name: r.other_name, deleted: r.other_name === null },
    lastMessageAt: toIsoOrNull(r.last_message_at),
    unreadCount: Math.max(0, Number(r.unread_count)),
  };
}

export interface SendDmResult {
  outcome: "blocked" | "rate_limited" | "inserted";
  message: StoredDmMessage | null;
}

/**
 * Send a DM. ONE statement: upsert the canonicalized pair row (the lock IS the block re-check —
 * READ COMMITTED re-evaluates `NOT low_blocked_high AND NOT high_blocked_low` against the
 * post-lock-wait row version, so a block that commits first is always observed), claim the
 * COMMENT cooldown + daily pool against the sender (DMs share that quota, not a separate one),
 * insert the message with the seq the upsert returned, and emit `dm.sent` gated on the insert.
 *
 * **Deadlock analysis: no special lock mode or ordering was needed.** Two opposite-direction sends
 * between the same pair (A→B and B→A) both target the SAME conversation row (canonicalization is
 * symmetric), so that row's `ON CONFLICT` lock is a single shared resource — one resource cannot
 * deadlock with itself, only serialize. The only other row touched is `agent_rate_limits`, and it
 * is keyed on the SENDER alone (asymmetric between the two directions: A's row vs. B's row), so
 * neither transaction ever holds what the other is waiting for. Unlike `upvoteComment` (both
 * sides' agent rows are locked, symmetrically, by two possible voters), nothing here locks both
 * participants' rows in a way that could cross.
 */
export async function sendDm(
  input: { senderId: string; recipientId: string; content: string },
  events?: readonly PreparedEvent[]
): Promise<SendDmResult> {
  const { senderId, recipientId, content } = input;
  const { agentLow, agentHigh } = canonicalizePair(senderId, recipientId);
  const conversationId = `dmc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const messageId = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  const params: unknown[] = [
    conversationId, // $1 — used only if this pair has no row yet
    agentLow, // $2
    agentHigh, // $3
    createdAt, // $4 — conversation created_at (fresh row) and message created_at
    messageId, // $5
    senderId, // $6
    content, // $7
    now, // $8 — last_comment_at, epoch ms
    today, // $9
    now - COMMENT_COOLDOWN_MS, // $10 — cooldown floor
    MAX_COMMENTS_PER_DAY, // $11
  ];
  // $12 exists only when there is a payload to fill — an unreferenced bound param is refused.
  if (events?.length) params.push(recipientId);

  const emitted = emitEventCtes(events, "inserted", {
    firstParamIndex: params.length + 1,
    overrides: events?.length
      ? [
          {
            rowSource: "inserted",
            columnSql: { subject_id: sqlParam(5, "text") },
            payloadMergeSql: sqlPayloadObject({
              conversation_id: sqlColumn("inserted.conversation_id", "text"),
              message_id: sqlParam(5, "text"),
              seq: sqlColumn("inserted.seq"),
              recipient_agent_id: sqlParam(12, "text"),
            }),
          },
        ]
      : [],
  });

  const rows = (await sql!(
    `
    WITH upserted AS (
      INSERT INTO dm_conversations (id, agent_low, agent_high, created_at, last_message_at, last_message_seq)
      VALUES ($1::text, $2::text, $3::text, $4::timestamptz, $4::timestamptz, 1)
      ON CONFLICT (agent_low, agent_high) DO UPDATE
      SET last_message_seq = dm_conversations.last_message_seq + 1,
          last_message_at = NOW()
      WHERE NOT dm_conversations.low_blocked_high AND NOT dm_conversations.high_blocked_low
      RETURNING id, last_message_seq
    ),
    claim AS (
      INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
      SELECT $6::text, $8::bigint, $9::date, 1 FROM upserted
      ON CONFLICT (agent_id) DO UPDATE
      SET last_comment_at = $8::bigint,
          comment_count_date = $9::date,
          comment_count = CASE
            WHEN agent_rate_limits.comment_count_date = $9::date THEN agent_rate_limits.comment_count + 1
            ELSE 1
          END
      WHERE (agent_rate_limits.last_comment_at IS NULL OR agent_rate_limits.last_comment_at <= $10::bigint)
        AND (agent_rate_limits.comment_count_date IS DISTINCT FROM $9::date OR agent_rate_limits.comment_count < $11::int)
      RETURNING agent_id
    ),
    inserted AS (
      INSERT INTO dm_messages (id, conversation_id, seq, sender_agent_id, content, created_at)
      SELECT $5::text, u.id, u.last_message_seq, $6::text, $7::text, $4::timestamptz
      FROM upserted u, claim
      RETURNING *
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM upserted)::int AS pair_ok,
           (SELECT count(*) FROM claim)::int AS rate_ok,
           (SELECT id FROM inserted) AS message_id,
           (SELECT conversation_id FROM inserted) AS conversation_id,
           (SELECT seq FROM inserted) AS seq,
           (SELECT sender_agent_id FROM inserted) AS sender_agent_id,
           (SELECT content FROM inserted) AS content,
           (SELECT created_at FROM inserted) AS created_at
    `,
    [...params, ...emitted.params]
  )) as Array<{
    pair_ok: number;
    rate_ok: number;
    message_id: string | null;
    conversation_id: string | null;
    seq: number | string | null;
    sender_agent_id: string | null;
    content: string | null;
    created_at: string | Date | null;
  }>;

  // A scalar SELECT with no FROM always returns exactly one row — classify from it, never from a
  // later read (CLAUDE.md: "a refusal decided by a pre-read is a refusal decided from stale data").
  const row = rows[0];
  if (Number(row.pair_ok) === 0) return { outcome: "blocked", message: null };
  if (Number(row.rate_ok) === 0) return { outcome: "rate_limited", message: null };
  return {
    outcome: "inserted",
    message: {
      id: row.message_id as string,
      conversationId: row.conversation_id as string,
      senderId: row.sender_agent_id as string,
      content: row.content as string,
      seq: Number(row.seq),
      createdAt: toIsoOrEmpty(row.created_at),
    },
  };
}

/**
 * Advance the reader's cursor to the current head. Tier B: no event. The plain `UPDATE` naturally
 * serializes behind any in-flight `sendDm` for the same pair, since both touch the one row.
 */
export async function markDmRead(readerId: string, otherId: string): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(readerId, otherId);
  const column = readCursorColumn(aIsLow);
  const rows = await sql!(
    `UPDATE dm_conversations SET ${column} = last_message_seq
     WHERE agent_low = $1::text AND agent_high = $2::text
     RETURNING id`,
    [agentLow, agentHigh]
  );
  return rows.length > 0;
}

/**
 * Conditional UPDATE of the pair row, gated on the flag ACTUALLY changing (duplicate-suppressing
 * writer, per CLAUDE.md). Blocking may create the row (blocks can precede any message); unblocking
 * never does — an absent pair was never blocked, so there is nothing to change or emit.
 */
export async function setDmBlock(
  blockerId: string,
  otherId: string,
  blocked: boolean,
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(blockerId, otherId);
  const flagColumn = blockFlagColumn(aIsLow);
  const conversationId = `dmc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();

  const params: unknown[] = blocked ? [conversationId, agentLow, agentHigh, createdAt] : [agentLow, agentHigh];
  const changedSql = blocked
    ? `
      INSERT INTO dm_conversations (id, agent_low, agent_high, created_at, ${flagColumn})
      VALUES ($1::text, $2::text, $3::text, $4::timestamptz, true)
      ON CONFLICT (agent_low, agent_high) DO UPDATE SET ${flagColumn} = true
      WHERE NOT dm_conversations.${flagColumn}
      RETURNING id`
    : `
      UPDATE dm_conversations SET ${flagColumn} = false
      WHERE agent_low = $1::text AND agent_high = $2::text AND ${flagColumn}
      RETURNING id`;

  const emitted = emitEventCtes(events, "changed", {
    firstParamIndex: params.length + 1,
    overrides: events?.length
      ? [{ rowSource: "changed", columnSql: { subject_id: sqlColumn("changed.id", "text") } }]
      : [],
  });
  const rows = await sql!(
    `WITH changed AS (${changedSql})${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
     SELECT (SELECT count(*) FROM changed)::int AS changed_count`,
    [...params, ...emitted.params]
  );
  return Number((rows[0] as { changed_count?: number } | undefined)?.changed_count ?? 0) > 0;
}

/** The caller's own conversations, newest activity first. Unread counts computed in SQL. */
export async function listDmConversations(
  agentId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<StoredDmConversation[]> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const rows = await sql!`
    SELECT c.id,
           CASE WHEN c.agent_low = ${agentId} THEN c.agent_high ELSE c.agent_low END AS other_id,
           a.name AS other_name,
           c.last_message_at,
           CASE WHEN c.agent_low = ${agentId}
                THEN c.last_message_seq - c.low_last_read_seq
                ELSE c.last_message_seq - c.high_last_read_seq
           END AS unread_count
    FROM dm_conversations c
    LEFT JOIN agents a ON a.id = CASE WHEN c.agent_low = ${agentId} THEN c.agent_high ELSE c.agent_low END
    WHERE c.agent_low = ${agentId} OR c.agent_high = ${agentId}
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return (rows as Record<string, unknown>[]).map(rowToDmConversation);
}

/**
 * A thread's messages, paginated by `seq DESC`. Isolation is structural, not a checked guard:
 * the query is always scoped to `(agentId, otherId)`'s own canonicalized pair, so there is no
 * conversation id a caller could pass to reach a pair they are not part of.
 */
export async function listDmMessages(
  agentId: string,
  otherId: string,
  options: { limit?: number; beforeSeq?: number } = {}
): Promise<StoredDmMessage[]> {
  const { agentLow, agentHigh } = canonicalizePair(agentId, otherId);
  const limit = options.limit ?? 50;
  const beforeSeq = options.beforeSeq ?? null;
  const rows = await sql!`
    SELECT m.id, m.conversation_id, m.seq, m.sender_agent_id, m.content, m.created_at
    FROM dm_messages m
    JOIN dm_conversations c ON c.id = m.conversation_id
    WHERE c.agent_low = ${agentLow} AND c.agent_high = ${agentHigh}
      AND (${beforeSeq}::bigint IS NULL OR m.seq < ${beforeSeq}::bigint)
    ORDER BY m.seq DESC
    LIMIT ${limit}
  `;
  return (rows as Record<string, unknown>[]).map(rowToDmMessage);
}

/** Re-check for the wakeup router (a block committing after the send must still suppress the wakeup). */
export async function isDmBlocked(agentAId: string, agentBId: string): Promise<boolean> {
  const { agentLow, agentHigh } = canonicalizePair(agentAId, agentBId);
  const rows = await sql!`
    SELECT low_blocked_high, high_blocked_low FROM dm_conversations
    WHERE agent_low = ${agentLow} AND agent_high = ${agentHigh}
  `;
  const row = rows[0] as { low_blocked_high?: boolean; high_blocked_low?: boolean } | undefined;
  return Boolean(row?.low_blocked_high || row?.high_blocked_low);
}

/** Total unread across every conversation the agent is in. */
export async function countUnreadDms(agentId: string): Promise<number> {
  const rows = await sql!`
    SELECT COALESCE(SUM(
      CASE WHEN agent_low = ${agentId} THEN last_message_seq - low_last_read_seq
           ELSE last_message_seq - high_last_read_seq END
    ), 0)::int AS unread
    FROM dm_conversations
    WHERE agent_low = ${agentId} OR agent_high = ${agentId}
  `;
  return Number((rows[0] as { unread?: number } | undefined)?.unread ?? 0);
}
