import type { StoredDmConversation, StoredDmMessage } from "@/lib/store-types";
import {
  agents,
  dmConversations,
  dmMessages,
  claimCommentAllowance,
  commentAllowanceAvailable,
} from "../_memory-state";
import type { PreparedEvent } from "@/lib/events/kinds";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents, type PreparedEventBatch } from "../events/memory";
import type { StoredEvent } from "@/lib/store-types";

export interface SendDmResult {
  outcome: "blocked" | "rate_limited" | "inserted";
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
 * Preflight events before mutation, then append with no await between mutation and append (Decision 4).
 */
function preflightEvents(events: readonly PreparedEvent[] | undefined): PreparedEventBatch {
  return prepareEventBatch(events);
}

/**
 * Append a preflighted batch and return the emitted events (after dispatch completes).
 */
function appendPreparedEvents(batch: PreparedEventBatch): Promise<StoredEvent[]> {
  const { stored, dispatched } = appendPreparedBatch(batch);
  return dispatched.then(() => stored);
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
  events?: readonly PreparedEvent[]
): Promise<SendDmResult> {
  const { senderId, recipientId, content } = input;

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

  // Preflight events BEFORE the mutation (Decision 4).
  validatePreparedEvents(events);

  // ---- Synchronous section: claim, upsert, insert. No await until event append. ----
  // Claim the allowance.
  if (!claimCommentAllowance(senderId)) {
    return { outcome: "rate_limited", message: null };
  }

  // Upsert conversation.
  const now = new Date().toISOString();
  if (!conv) {
    const conversationId = `dmc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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

  // Increment seq and update timestamp.
  conv.lastMessageSeq += 1;
  conv.lastMessageAt = now;

  // Insert message.
  const messageId = `dm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const message: StoredDmMessage = {
    id: messageId,
    conversationId: conv.id,
    senderId,
    content,
    seq: conv.lastMessageSeq,
    createdAt: now,
  };
  dmMessages.set(messageId, message);
  // ---- End synchronous section. ----

  // Emit events with positional primary substitution (after main mutation).
  if (events?.length) {
    const prepared = withCreatedDmMessageId(events, messageId, conv.id, conv.lastMessageSeq, recipientId);
    const batch = preflightEvents(prepared);
    await appendPreparedEvents(batch);
  }

  return { outcome: "inserted", message };
}

/**
 * Mark messages read. Find the conversation (do not create), then set the reader's cursor to head.
 */
export async function markDmRead(readerId: string, otherId: string): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(readerId, otherId);
  const conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );
  if (!conv) return false;

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
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  const { agentLow, agentHigh, aIsLow } = canonicalizePair(blockerId, otherId);
  const flagField = blockFlagField(aIsLow);

  let conv = Array.from(dmConversations.values()).find(
    (c) => c.agentLow === agentLow && c.agentHigh === agentHigh
  );

  if (!conv) {
    if (!blocked) return false; // Can't unblock a row that doesn't exist.
    // Create it.
    const now = new Date().toISOString();
    const conversationId = `dmc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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

  const oldValue = conv[flagField];
  if (oldValue === blocked) return false; // No change.

  validatePreparedEvents(events);

  // Mutate the flag.
  conv[flagField] = blocked;

  // Emit events with positional substitution.
  if (events?.length) {
    const prepared = events.map((event, index) =>
      index === 0
        ? ({
            ...event,
            subjectId: conv.id,
            payload: {
              ...(event.payload as Record<string, unknown>),
              conversation_id: conv.id,
              target_agent_id: otherId,
            },
          } as PreparedEvent)
        : event
    );
    const batch = preflightEvents(prepared);
    await appendPreparedEvents(batch);
  }

  return true;
}

/**
 * List the agent's conversations. Newest activity first (by last_message_at DESC, then created_at DESC).
 * Includes unread count (last_message_seq - my_last_read_seq). Other participant may be deleted.
 */
export async function listDmConversations(
  agentId: string,
  options: { limit?: number; offset?: number } = {}
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

  // Sort by last_message_at DESC, then created_at DESC (nulls last).
  withUnread.sort((a, b) => {
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
