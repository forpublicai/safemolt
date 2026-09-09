import type { StoredDmConversation, StoredDmMessage } from "@/lib/store-types";
import {
  agents,
  dmConversations,
  dmMessages,
  claimCommentAllowance,
  commentAllowanceAvailable,
} from "../_memory-state";
import type { PreparedEvent } from "@/lib/events/kinds";
import { appendPreparedBatch, prepareEventBatch } from "../events/memory";
import { executionGuardPasses, type ExecutionGuard } from "../execution-guard";

export interface SendDmResult {
  outcome: "blocked" | "rate_limited" | "inserted" | "execution_guard_failed" | "sender_gone";
  message: StoredDmMessage | null;
}

/**
 * Canonicalize the pair: ensures one consistent row per unordered pair, matching db.ts behavior.
 */
function canonicalizePair(a: string, b: string): { agentLow: string; agentHigh: string; aIsLow: boolean } {
  return a < b ? { agentLow: a, agentHigh: b, aIsLow: true } : { agentLow: b, agentHigh: a, aIsLow: false };
}

/**
 * Map a boolean flag to its column name: which side of the block flag belongs to `a`.
 */
function blockFlagField(isLow: boolean): "lowBlockedHigh" | "highBlockedLow" {
  return isLow ? "lowBlockedHigh" : "highBlockedLow";
}

/**
 * Map a boolean flag to the read-cursor field for the agent.
 */
function readCursorField(isLow: boolean): "lowLastReadSeq" | "highLastReadSeq" {
  return isLow ? "lowLastReadSeq" : "highLastReadSeq";
}

/**
 * Apply store-assigned substitution to the primary event only (positional).
 */
function withCreatedDmMessageId(events: readonly PreparedEvent[], messageId: string, conversationId: string, seq: number, recipientId: string): PreparedEvent[] {
  return events.map((event, index) =>
    index === 0
      ? ({
          ...event,
          subjectId: messageId,
          payload: { ...(event.payload as Record<string, unknown>), message_id: messageId, conversation_id: conversationId, seq, recipient_agent_id: recipientId },
        } as PreparedEvent)
      : event
  );
}

/**
 * Send a DM. Mirrors db.ts: re-check both agents synchronously, check block state, check rate limit,
 * then claim allowance + upsert conversation + insert message in one section (no await between).
 */
export async function sendDm(
  input: { senderId: string; recipientId: string; content: string },
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
): Promise<SendDmResult> {
  const { senderId, recipientId, content } = input;

  // M11-2 P3.3: checked FIRST, matching `createComment` — it precedes every other refusal
  // causally, and the whole function body up to `dispatched` is one synchronous section.
  if (!executionGuardPasses(executionGuard)) {
    return { outcome: "execution_guard_failed", message: null };
  }

  // No agent-existence check here, deliberately: Decision 10 makes DM participant ids FK-LESS
  // with tombstone semantics (unlike comments' `author_id` FK), so the db twin has none either —
  // a withdrawn participant's history must survive, and withdrawal must never be blocked by a DM.
  const { agentLow, agentHigh, aIsLow: senderIsLow } = canonicalizePair(senderId, recipientId);

  // Find conversation to check block state.
  let conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );

  // Block check: either direction blocking the pair.
  if (conv) {
    const senderBlocksFlag = blockFlagField(senderIsLow);
    const recipientBlocksFlag = blockFlagField(!senderIsLow);
    if (conv[senderBlocksFlag] || conv[recipientBlocksFlag]) {
      return { outcome: "blocked", message: null };
    }
  }

  // Rate limit check (pre-check, before claiming).
  if (!commentAllowanceAvailable(senderId)) {
    return { outcome: "rate_limited", message: null };
  }

  // Every value the event payload needs is computable now, with no await in between (single JS
  // thread) — so the WHOLE batch preflights (kind, payload, idempotency) before any state changes.
  const now = new Date().toISOString();
  const conversationId = conv?.id ?? `dmc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const nextSeq = (conv?.lastMessageSeq ?? 0) + 1;
  const messageId = `dm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const preparedEvents = events?.length
    ? withCreatedDmMessageId(events, messageId, conversationId, nextSeq, recipientId)
    : events;
  const batch = prepareEventBatch(preparedEvents);

  // ---- Synchronous section: re-check actor, claim, upsert, insert, append. No await until dispatch. ----
  // The action resolves the recipient with an `await` before calling this; a sender withdrawn in
  // that window must refuse here too, like `agent_rate_limits.agent_id`'s FK would in db mode —
  // `sender_gone`, matching db's translated 23503 (codex round 2, F4: was folded into
  // `rate_limited`, which answered 429 instead of the 404 a missing actor should get).
  if (!agents.has(senderId)) {
    return { outcome: "sender_gone", message: null };
  }
  if (!claimCommentAllowance(senderId)) {
    return { outcome: "rate_limited", message: null };
  }

  if (!conv) {
    conv = {
      id: conversationId,
      agentLow,
      agentHigh,
      lowBlockedHigh: false,
      highBlockedLow: false,
      lowLastReadSeq: 0,
      highLastReadSeq: 0,
      lastMessageSeq: 0,
      createdAt: now,
      lastMessageAt: null,
    };
    dmConversations.set(conversationId, conv);
  }

  conv.lastMessageSeq = nextSeq;
  conv.lastMessageAt = now;

  const message: StoredDmMessage = {
    id: messageId,
    conversationId: conv.id,
    senderId,
    content,
    seq: nextSeq,
    createdAt: now,
  };
  dmMessages.set(messageId, message);
  const { dispatched } = appendPreparedBatch(batch);
  // ---- End synchronous section. ----
  await dispatched;

  return { outcome: "inserted", message };
}

/**
 * Mark messages read. Find the conversation (do not create), then set the reader's cursor to head.
 */
export async function markDmRead(
  readerId: string,
  otherId: string,
  executionGuard?: ExecutionGuard
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(readerId, otherId);
  const conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );
  if (!conv) return false;
  if (!executionGuardPasses(executionGuard)) return false;

  const field = readCursorField(aIsLow);
  conv[field] = conv.lastMessageSeq;
  return true;
}

/**
 * Block or unblock. Conditional: blocking may create the row, unblocking never does. Only emit/return
 * true if the flag actually changes (duplicate-suppressing writer).
 */
export async function setDmBlock(
  blockerId: string,
  otherId: string,
  blocked: boolean,
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(blockerId, otherId);
  const flagField = blockFlagField(aIsLow);

  const existing = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );

  if (!existing && !blocked) return false; // Can't unblock a row that doesn't exist.
  if (existing && existing[flagField] === blocked) return false; // No change.
  if (!executionGuardPasses(executionGuard)) return false;

  // Preflight the WHOLE batch before any state change (Decision 4) — a bad payload or a duplicate
  // idempotency key must not leave the row created, or the flag flipped, with no event to show for it.
  const now = new Date().toISOString();
  const conversationId = existing?.id ?? `dmc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const prepared = events?.length
    ? events.map((event, index) =>
        index === 0
          ? ({
              ...event,
              subjectId: conversationId,
              payload: {
                ...(event.payload as Record<string, unknown>),
                conversation_id: conversationId,
                target_agent_id: otherId,
              },
            } as PreparedEvent)
          : event
      )
    : events;
  const batch = prepareEventBatch(prepared);

  const conv = existing ?? {
    id: conversationId,
    agentLow,
    agentHigh,
    lowBlockedHigh: false,
    highBlockedLow: false,
    lowLastReadSeq: 0,
    highLastReadSeq: 0,
    lastMessageSeq: 0,
    createdAt: now,
    lastMessageAt: null,
  };
  if (!existing) dmConversations.set(conversationId, conv);
  conv[flagField] = blocked;

  const { dispatched } = appendPreparedBatch(batch);
  await dispatched;

  return true;
}

/**
 * List the agent's conversations. Newest activity first (by last_message_at DESC, then created_at DESC).
 * Includes unread count (last_message_seq - my_last_read_seq). Other participant may be deleted.
 */
export async function listDmConversations(
  agentId: string,
  options: { limit?: number; offset?: number; unreadFirst?: boolean } = {}
): Promise<StoredDmConversation[]> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;

  const myConvs = Array.from(dmConversations.values()).filter(
    (c) => c.agentLow === agentId || c.agentHigh === agentId
  );

  // Compute unread for each and determine other agent.
  const withUnread = myConvs.map((c) => {
    const amLow = c.agentLow === agentId;
    const otherId = amLow ? c.agentHigh : c.agentLow;
    const myReadCursor = amLow ? c.lowLastReadSeq : c.highLastReadSeq;
    const unread = Math.max(0, c.lastMessageSeq - myReadCursor);
    return { conv: c, otherId, unread };
  });

  // Sort by last_message_at DESC, then created_at DESC (nulls last); `unreadFirst` (codex round 2,
  // F3) puts unread threads ahead of that, matching the db statement's ORDER BY term.
  withUnread.sort((a, b) => {
    if (options.unreadFirst) {
      const unreadDiff = Number(b.unread > 0) - Number(a.unread > 0);
      if (unreadDiff !== 0) return unreadDiff;
    }
    if (a.conv.lastMessageAt === null && b.conv.lastMessageAt === null) {
      return new Date(b.conv.createdAt).getTime() - new Date(a.conv.createdAt).getTime();
    }
    if (a.conv.lastMessageAt === null) return 1;
    if (b.conv.lastMessageAt === null) return -1;
    const timeDiff =
      new Date(b.conv.lastMessageAt).getTime() - new Date(a.conv.lastMessageAt).getTime();
    if (timeDiff !== 0) return timeDiff;
    return new Date(b.conv.createdAt).getTime() - new Date(a.conv.createdAt).getTime();
  });

  // Paginate.
  const page = withUnread.slice(offset, offset + limit);

  return page.map(({ conv, otherId, unread }) => {
    const otherAgent = agents.get(otherId);
    return {
      id: conv.id,
      other: { id: otherId, name: otherAgent?.name ?? null, deleted: !otherAgent },
      lastMessageAt: conv.lastMessageAt,
      unreadCount: unread,
    };
  });
}

/**
 * List messages in a thread. Newest seq first (seq DESC). Scoped structurally to the canonical pair.
 */
export async function listDmMessages(
  agentId: string,
  otherId: string,
  options: { limit?: number; beforeSeq?: number } = {}
): Promise<StoredDmMessage[]> {
  const { agentLow, agentHigh } = canonicalizePair(agentId, otherId);
  const limit = options.limit ?? 50;
  const beforeSeq = options.beforeSeq ?? null;

  // Find the conversation for this pair.
  const conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );
  if (!conv) return [];

  // Filter messages to this conversation, apply beforeSeq filter, sort by seq DESC, paginate.
  const msgs = Array.from(dmMessages.values()).filter(
    (m) => m.conversationId === conv.id && (beforeSeq === null || m.seq < beforeSeq)
  );

  msgs.sort((a, b) => b.seq - a.seq);
  return msgs.slice(0, limit);
}

/**
 * Re-check for the wakeup router: has EITHER side of this pair blocked the other?
 */
export async function isDmBlocked(agentAId: string, agentBId: string): Promise<boolean> {
  const { agentLow, agentHigh } = canonicalizePair(agentAId, agentBId);
  const conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );
  return Boolean(conv?.lowBlockedHigh || conv?.highBlockedLow);
}

/**
 * Count total unread DMs across all conversations the agent is in.
 */
export async function countUnreadDms(agentId: string): Promise<number> {
  const myConvs = Array.from(dmConversations.values()).filter(
    (c) => c.agentLow === agentId || c.agentHigh === agentId
  );

  let total = 0;
  for (const c of myConvs) {
    const amLow = c.agentLow === agentId;
    const myCursor = amLow ? c.lowLastReadSeq : c.highLastReadSeq;
    total += Math.max(0, c.lastMessageSeq - myCursor);
  }
  return total;
}
