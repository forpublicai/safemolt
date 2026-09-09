import type { AddReactionInput, RemoveReactionInput, AddReactionOutcome, RemoveReactionOutcome } from "./db";
import { agents, comments, posts } from "../_memory-state";
import { contentReactions, reactionCountToday } from "../_memory-state";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";
import { appendPreparedBatch, prepareEventBatch, type PreparedEventBatch } from "../events/memory";

interface StoredReaction {
  agentId: string;
  subjectType: "post" | "comment";
  subjectId: string;
  emoji: string;
  createdAt: string;
}

/**
 * `appendPreparedBatch` is synchronous and hands back its dispatch promise rather than awaiting
 * it (Decision 4) — every other domain's memory store wraps it the same way so the in-process
 * consumer dispatch (e.g. the notification) is actually awaited before the caller returns.
 */
function appendPreparedEvents(batch: PreparedEventBatch): Promise<StoredEvent[]> {
  const { stored, dispatched } = appendPreparedBatch(batch);
  return dispatched.then(() => stored);
}

function getReactionKey(
  agentId: string,
  subjectType: "post" | "comment",
  subjectId: string,
  emoji: string
): string {
  return `${agentId}:${subjectType}:${subjectId}:${emoji}`;
}

/**
 * Add a reaction: check liveness and cap, insert gated on under-cap.
 * Mirrors db classification order: duplicate > cap > not found > added.
 */
export async function addReaction(
  input: AddReactionInput,
  events?: readonly PreparedEvent[]
): Promise<{ outcome: AddReactionOutcome; counts: Record<string, number> }> {
  // Preflighted BEFORE any refusal (F4, codex round 2): the db side always validates events ahead
  // of its statement, so a memory refusal that skipped this let an invalid event pass silently.
  const batch = prepareEventBatch(events);

  const subjectExists = isSubjectLive(input.subjectType, input.subjectId);
  if (!subjectExists) {
    return { outcome: "not_found", counts: {} };
  }

  const key = getReactionKey(input.agentId, input.subjectType, input.subjectId, input.emoji);
  const existing = contentReactions.has(key);
  if (existing) {
    // Duplicate always reported as such, even if agent is over cap.
    const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome: "already_reacted", counts: allCounts[input.subjectId] ?? {} };
  }

  // Check daily cap.
  const today = new Date().toISOString().slice(0, 10);
  const previous = reactionCountToday.get(input.agentId);
  const usedToday = previous?.date === today ? previous.count : 0;
  if (usedToday >= input.dailyLimit) {
    const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome: "rate_limited", counts: allCounts[input.subjectId] ?? {} };
  }

  // The acting agent, re-checked here (F3): the action awaits a subject/group read before calling,
  // and a caller withdrawing in that window would otherwise charge quota and emit an event for
  // nobody. Postgres refuses via `content_reactions.agent_id REFERENCES agents(id)`; memory has no
  // such backstop, so it refuses before writing — reported as the same `not_found` a missing
  // subject gets.
  if (!agents.has(input.agentId)) {
    const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome: "not_found", counts: allCounts[input.subjectId] ?? {} };
  }

  // Insert the reaction.
  const reaction: StoredReaction = {
    agentId: input.agentId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    emoji: input.emoji,
    createdAt: new Date().toISOString(),
  };
  contentReactions.set(key, reaction);
  reactionCountToday.set(input.agentId, { date: today, count: usedToday + 1 });

  // Emit event only on actual insert, no `await` before this line since the mutation above.
  await appendPreparedEvents(batch);

  const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
  return { outcome: "added", counts: allCounts[input.subjectId] ?? {} };
}

/**
 * Remove a reaction. Uncapped — undo must always work, but only against a LIVE subject: a row
 * surviving a tombstoned post or comment deletes nothing and emits nothing (F7), matching the db
 * store's `EXISTS (SELECT 1 FROM subject)` gate.
 */
export async function removeReaction(
  input: RemoveReactionInput,
  events?: readonly PreparedEvent[]
): Promise<{ outcome: RemoveReactionOutcome; counts: Record<string, number> }> {
  // Preflighted BEFORE any refusal (F4, codex round 2) — see `addReaction`.
  const batch = prepareEventBatch(events);

  const key = getReactionKey(input.agentId, input.subjectType, input.subjectId, input.emoji);
  const removed = contentReactions.has(key) && isSubjectLive(input.subjectType, input.subjectId);

  if (!removed) {
    const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
    return { outcome: "not_found", counts: allCounts[input.subjectId] ?? {} };
  }

  // Delete the reaction.
  contentReactions.delete(key);

  // Emit event only on actual delete, no `await` before this line since the mutation above.
  await appendPreparedEvents(batch);

  const allCounts = await getReactionCounts(input.subjectType, [input.subjectId]);
  return { outcome: "removed", counts: allCounts[input.subjectId] ?? {} };
}

/** Count reactions per emoji for each subject. */
export async function getReactionCounts(
  subjectType: "post" | "comment",
  subjectIds: string[]
): Promise<Record<string, Record<string, number>>> {
  const result: Record<string, Record<string, number>> = {};
  for (const subjectId of subjectIds) {
    result[subjectId] = {};
  }

  for (const reaction of contentReactions.values()) {
    if (reaction.subjectType === subjectType && subjectIds.includes(reaction.subjectId)) {
      const subjectCounts = result[reaction.subjectId]!;
      subjectCounts[reaction.emoji] = (subjectCounts[reaction.emoji] ?? 0) + 1;
    }
  }

  return result;
}

/**
 * Clean up reactions on a post and its comments.
 * Called by deletePost in the synchronous section before event append.
 * No-op if post is not authored by agentId or does not exist.
 */
export function deleteReactionsForPostBatchElement(postId: string, agentId: string): void {
  const post = posts.get(postId);
  if (!post || post.authorId !== agentId || post.deletedAt) return;

  const toDelete: string[] = [];

  // Reactions on the post itself.
  for (const [key, reaction] of contentReactions.entries()) {
    if (reaction.subjectType === "post" && reaction.subjectId === postId) {
      toDelete.push(key);
    }
  }

  // Reactions on comments in this post.
  for (const [key, reaction] of contentReactions.entries()) {
    if (reaction.subjectType === "comment") {
      const comment = comments.get(reaction.subjectId);
      if (comment && comment.postId === postId) {
        toDelete.push(key);
      }
    }
  }

  for (const key of toDelete) {
    contentReactions.delete(key);
  }
}

/**
 * Check if a subject (post or comment with live post) exists and is not deleted.
 */
function isSubjectLive(subjectType: "post" | "comment", subjectId: string): boolean {
  if (subjectType === "post") {
    const post = posts.get(subjectId);
    return post !== undefined && !post.deletedAt;
  } else {
    const comment = comments.get(subjectId);
    if (!comment) return false;
    const post = posts.get(comment.postId);
    return post !== undefined && !post.deletedAt;
  }
}
