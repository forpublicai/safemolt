import { sql } from "@/lib/db";
import type { StoredDmConversation, StoredDmMessage } from "@/lib/store-types";
import { toIsoOrEmpty, toIsoOrNull } from "@/lib/iso-date";
import type { PreparedEvent } from "@/lib/events/kinds";
import { emitEventCtes, sqlColumn, sqlParam, sqlPayloadObject } from "../events/statement";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY } from "../rate-limit-windows";
import { buildExecutionGuardCte, type ExecutionGuard } from "../execution-guard";

/** The sender-side FK `agent_rate_limits.agent_id` — a withdrawn sender trips this, not a 500. */
const SENDER_RATE_LIMIT_FK = "agent_rate_limits_agent_id_fkey";

function isSenderForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; constraint?: unknown };
  return failure.code === "23503" && failure.constraint === SENDER_RATE_LIMIT_FK;
}

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
  outcome: "blocked" | "rate_limited" | "inserted" | "execution_guard_failed" | "sender_gone";
  message: StoredDmMessage | null;
}

/**
 * Send a DM. Statement 1 ensures the pair row exists (a fresh pair's bump would otherwise no-op,
 * since sibling CTEs never see each other's writes to the same table). Statement 2 locks that row,
 * re-checks the block flags, claims the shared comment cooldown, and bumps the seq only when the
 * claim also succeeds, so a refused attempt burns no seq number.
 */
export async function sendDm(
  input: { senderId: string; recipientId: string; content: string },
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
): Promise<SendDmResult> {
  const { senderId, recipientId, content } = input;
  const { agentLow, agentHigh } = canonicalizePair(senderId, recipientId);
  const conversationId = `dmc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const messageId = `dm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // No `conversationId` here: statement 1 (below) mints it through its OWN tagged-template
  // parameter space, and statement 2 never references it — an unreferenced bound parameter is a
  // Neon `42P18` ("could not determine data type"), not a silent no-op.
  const params: unknown[] = [
    agentLow, // $1
    agentHigh, // $2
    createdAt, // $3 — message created_at
    messageId, // $4
    senderId, // $5
    content, // $6
    now, // $7 — last_comment_at, epoch ms
    today, // $8
    now - COMMENT_COOLDOWN_MS, // $9 — cooldown floor
    MAX_COMMENTS_PER_DAY, // $10
  ];
  // $11 exists only when there is a payload to fill — an unreferenced bound param is refused.
  if (events?.length) params.push(recipientId);

  const emitted = emitEventCtes(events, "inserted", {
    firstParamIndex: params.length + 1,
    overrides: events?.length
      ? [
          {
            rowSource: "inserted",
            columnSql: { subject_id: sqlParam(4, "text") },
            payloadMergeSql: sqlPayloadObject({
              conversation_id: sqlColumn("inserted.conversation_id", "text"),
              message_id: sqlParam(4, "text"),
              seq: sqlColumn("inserted.seq"),
              recipient_agent_id: sqlParam(11, "text"),
            }),
          },
        ]
      : [],
  });

  // M11-2 P3.3: rendered LAST, after every event param, so its own placeholder numbering never
  // moves when `emitted.params` grows or shrinks (mirrors `createComment`).
  const guard = buildExecutionGuardCte(executionGuard, params.length + 1 + emitted.params.length);
  const allParams = [...params, ...emitted.params, ...guard.params];
  let results: unknown[];
  try {
    results = await sql!.transaction((txn) => [
      txn`
      INSERT INTO dm_conversations (id, agent_low, agent_high, created_at, last_message_seq)
      VALUES (${conversationId}::text, ${agentLow}::text, ${agentHigh}::text, ${createdAt}::timestamptz, 0)
      ON CONFLICT (agent_low, agent_high) DO NOTHING
    `,
      txn(
        `
    WITH target AS (
      SELECT id, low_blocked_high, high_blocked_low FROM dm_conversations /* race:dm-send-pair-lock */
      WHERE agent_low = $1::text AND agent_high = $2::text
      FOR NO KEY UPDATE
    )${guard.cte ? `,\n    ${guard.cte}` : ""},
    not_blocked AS (
      SELECT id FROM target WHERE NOT low_blocked_high AND NOT high_blocked_low
    ),
    claim AS (
      INSERT INTO agent_rate_limits (agent_id, last_comment_at, comment_count_date, comment_count)
      SELECT $5::text, $7::bigint, $8::date, 1 FROM not_blocked
      ${guard.cte ? "WHERE EXISTS (SELECT 1 FROM guard)" : ""}
      ON CONFLICT (agent_id) DO UPDATE
      SET last_comment_at = $7::bigint,
          comment_count_date = $8::date,
          comment_count = CASE
            WHEN agent_rate_limits.comment_count_date = $8::date THEN agent_rate_limits.comment_count + 1
            ELSE 1
          END
      WHERE (agent_rate_limits.last_comment_at IS NULL OR agent_rate_limits.last_comment_at <= $9::bigint)
        AND (agent_rate_limits.comment_count_date IS DISTINCT FROM $8::date OR agent_rate_limits.comment_count < $10::int)
      RETURNING agent_id
    ),
    -- The ONLY writer of last_message_seq -- gated on the claim, so a rate-limited (or blocked)
    -- attempt burns no seq number and moves neither timestamp.
    bumped AS (
      UPDATE dm_conversations
      SET last_message_seq = last_message_seq + 1,
          last_message_at = NOW()
      WHERE id = (SELECT id FROM not_blocked) AND EXISTS (SELECT 1 FROM claim)
      RETURNING id, last_message_seq
    ),
    inserted AS (
      INSERT INTO dm_messages (id, conversation_id, seq, sender_agent_id, content, created_at)
      SELECT $4::text, b.id, b.last_message_seq, $5::text, $6::text, $3::timestamptz
      FROM bumped b
      RETURNING *
    )${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
    SELECT (SELECT count(*) FROM not_blocked)::int AS pair_ok,
           (SELECT count(*) FROM claim)::int AS rate_ok,
           (SELECT id FROM inserted) AS message_id,
           (SELECT conversation_id FROM inserted) AS conversation_id,
           (SELECT seq FROM inserted) AS seq,
           (SELECT sender_agent_id FROM inserted) AS sender_agent_id,
           (SELECT content FROM inserted) AS content,
           (SELECT created_at FROM inserted) AS created_at${
             guard.cte ? `,\n           (SELECT count(*) FROM guard)::int AS guard_passed` : ""
           }
    `,
        allParams
      ),
    ]);
  } catch (error) {
    // The sender can withdraw between the action's lookup and this statement; the same refusal in
    // both stores, not a 500 (codex round 2, F4).
    if (isSenderForeignKeyViolation(error)) return { outcome: "sender_gone", message: null };
    throw error;
  }

  const rows = results[1] as Array<{
    pair_ok: number;
    rate_ok: number;
    message_id: string | null;
    conversation_id: string | null;
    seq: number | string | null;
    sender_agent_id: string | null;
    content: string | null;
    created_at: string | Date | null;
    guard_passed?: number;
  }>;

  // A scalar SELECT with no FROM always returns exactly one row — classify from it, never from a
  // later read (CLAUDE.md: "a refusal decided by a pre-read is a refusal decided from stale data").
  // The guard is checked FIRST, matching `createComment`'s precedence — it precedes every other
  // refusal causally, since it is what a runner-driven caller needs distinguished.
  const row = rows[0];
  if (executionGuard && Number(row.guard_passed ?? 0) === 0) {
    return { outcome: "execution_guard_failed", message: null };
  }
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
export async function markDmRead(
  readerId: string,
  otherId: string,
  executionGuard?: ExecutionGuard
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(readerId, otherId);
  const column = readCursorColumn(aIsLow);
  const guard = buildExecutionGuardCte(executionGuard, 3);
  const rows = await sql!(
    `${guard.cte ? `WITH ${guard.cte} ` : ""}UPDATE dm_conversations /* race:dm-send-pair-lock */ SET ${column} = last_message_seq
     WHERE agent_low = $1::text AND agent_high = $2::text${guard.cte ? " AND EXISTS (SELECT 1 FROM guard)" : ""}
     RETURNING id`,
    [agentLow, agentHigh, ...guard.params]
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
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(blockerId, otherId);
  const flagColumn = blockFlagColumn(aIsLow);
  const conversationId = `dmc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = new Date().toISOString();

  const params: unknown[] = blocked ? [conversationId, agentLow, agentHigh, createdAt] : [agentLow, agentHigh];
  const emitted = emitEventCtes(events, "changed", {
    firstParamIndex: params.length + 1,
    overrides: events?.length
      ? [
          {
            rowSource: "changed",
            columnSql: { subject_id: sqlColumn("changed.id", "text") },
            payloadMergeSql: sqlPayloadObject({ conversation_id: sqlColumn("changed.id", "text") }),
          },
        ]
      : [],
  });
  const guard = buildExecutionGuardCte(executionGuard, params.length + 1 + emitted.params.length);
  // Blocked=true must gate the INSERT branch too, not only the ON CONFLICT branch — `SELECT ...
  // FROM guard` makes the whole INSERT source zero rows when the guard fails, instead of a WHERE
  // clause that only reaches the conflict path.
  const changedSql = blocked
    ? `
      INSERT INTO dm_conversations /* race:dm-send-pair-lock */ (id, agent_low, agent_high, created_at, ${flagColumn})
      SELECT $1::text, $2::text, $3::text, $4::timestamptz, true${guard.cte ? " FROM guard" : ""}
      ON CONFLICT (agent_low, agent_high) DO UPDATE SET ${flagColumn} = true
      WHERE NOT dm_conversations.${flagColumn}${guard.cte ? " AND EXISTS (SELECT 1 FROM guard)" : ""}
      RETURNING id`
    : `
      UPDATE dm_conversations /* race:dm-send-pair-lock */ SET ${flagColumn} = false
      WHERE agent_low = $1::text AND agent_high = $2::text AND ${flagColumn}${guard.cte ? " AND EXISTS (SELECT 1 FROM guard)" : ""}
      RETURNING id`;

  const rows = await sql!(
    `WITH ${guard.cte ? `${guard.cte},\n     ` : ""}changed AS (${changedSql})${emitted.ctes.length > 0 ? `, ${emitted.ctes.join(", ")}` : ""}
     SELECT (SELECT count(*) FROM changed)::int AS changed_count`,
    [...params, ...emitted.params, ...guard.params]
  );
  return Number((rows[0] as { changed_count?: number } | undefined)?.changed_count ?? 0) > 0;
}

/**
 * The caller's own conversations, newest activity first. Unread counts computed in SQL.
 *
 * `unreadFirst` (codex round 2, F3) selects unread threads BEFORE the limit, rather than after —
 * a caller that filters post-limit can have an older unread thread pushed out entirely by newer
 * read ones. Off by default: `/api/v1/dm`'s plain recency ordering is unaffected.
 */
export async function listDmConversations(
  agentId: string,
  options: { limit?: number; offset?: number; unreadFirst?: boolean } = {}
): Promise<StoredDmConversation[]> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const unreadTerm = `CASE WHEN c.agent_low = $1::text
                THEN c.last_message_seq - c.low_last_read_seq
                ELSE c.last_message_seq - c.high_last_read_seq
           END`;
  const rows = await sql!(
    `
    SELECT c.id,
           CASE WHEN c.agent_low = $1::text THEN c.agent_high ELSE c.agent_low END AS other_id,
           a.name AS other_name,
           c.last_message_at,
           ${unreadTerm} AS unread_count
    FROM dm_conversations c
    LEFT JOIN agents a ON a.id = CASE WHEN c.agent_low = $1::text THEN c.agent_high ELSE c.agent_low END
    WHERE c.agent_low = $1::text OR c.agent_high = $1::text
    ORDER BY ${options.unreadFirst ? `(${unreadTerm}) > 0 DESC,` : ""}
             c.last_message_at DESC NULLS LAST, c.created_at DESC
    LIMIT $2::int OFFSET $3::int
    `,
    [agentId, limit, offset]
  );
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
