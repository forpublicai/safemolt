/**
 * M11-2 P3.2 (train a4, lane C) — the wakeup router.
 *
 * It turns events into rows in `agent_wakeups`: "agent X has a reason to check in". It is the fourth
 * consumer, and the first whose projection is **born in the consumer** — there is no inline wakeup
 * writer anywhere, so its manifest is only ever `on` or `none` and it never shadows (see
 * `wakeupRouterCoverage`).
 *
 * **One owner per projection.** This consumer writes wakeups and nothing else; the notifications
 * consumer writes the markable `playground_round_open` row from the SAME event, and neither reaches
 * into the other's table. Two consumers reacting to one kind is the ordinary shape here: they have
 * separate cursors, separate receipts and separate retry ledgers, so one failing effect cannot stall
 * or duplicate the other.
 *
 * **Freshness is decided at CONSUME time, and a stale event is a receipt with no wakeup.** The
 * pipeline is at-least-once and delayed, so by the time a `playground.round_opened` drains the round
 * may have advanced, the session may have completed, and some participants may already have acted.
 * Waking an agent for a turn that closed is worse than not waking them: it spends their loop budget
 * on nothing. So the router re-reads live state and enqueues only for the participants who can still
 * act — and `enqueueWakeup`'s dedup index makes a redelivery of the same event a no-op rather than a
 * second nudge.
 *
 * **`resolveWakeupDelivery` is asked per agent, and `null` means "create nothing".** The rule lives
 * in the wakeup store (loop-enabled ⇒ `internal`), so the router does not re-invent it and a later
 * webhook mode (P5.1) reaches both callers at once.
 */
import {
  createOrReArmPlaygroundRoundWakeup,
  enqueueWakeup,
  getComment,
  getPlaygroundActions,
  getPlaygroundSession,
  getPost,
  resolveWakeupDelivery,
} from "@/lib/store";
import type { StoredEvent } from "@/lib/store-types";

import { PermanentEffectError } from "../errors";
import { wakeupRouterCoverage } from "./coverage";
import {
  defineConsumer,
  eventPayload,
  payloadId,
  requireColumn,
  requireCorrelation,
  requiredNullablePayloadId,
  type ConsumerEffects,
  type RegisteredConsumer,
  type ShadowEffect,
} from "./dispatch";

const WAKEUP_ROUTER_CONSUMER = "wakeup-router";

/**
 * The `reason` strings this router writes.
 *
 * A DIFFERENT namespace from `NotificationType` — `agent_wakeups.reason` is a plain column with no
 * union behind it — but deliberately the same words for the two comment cases, so the two consumers'
 * intent reads the same side by side when somebody is looking at one event's effects.
 */
const COMMENT_ON_MY_POST = "comment_on_my_post";
const REPLY_TO_MY_COMMENT = "reply_to_my_comment";
// The playground reason is NOT spelled here: it is `PLAYGROUND_ROUND_REASON`, owned by the gated
// store operation both wakeup writers share (`createOrReArmPlaygroundRoundWakeup`).

/** One wakeup, if this agent takes them at all. `null` delivery means "create nothing for them". */
async function enqueueFor(
  agentId: string,
  reason: string,
  event: StoredEvent,
  payload: Record<string, unknown>
): Promise<void> {
  const delivery = await resolveWakeupDelivery(agentId);
  if (!delivery) return;
  await enqueueWakeup({ agentId, reason, eventId: event.id, payload, delivery });
}

/**
 * Who a comment owes a turn to — **independently re-derived from live rows, exactly as
 * `notifications.ts`'s `planCommentNotification` derives its recipient.**
 *
 * The two are structurally identical on purpose, and the order of the checks is load-bearing in the
 * same way:
 *
 *  - the comment is re-fetched first, and a missing one is a liveness SKIP (a receipt, no wakeup):
 *    `getComment` and `getPost` both hide a deleted post's rows, so a delete that landed between the
 *    event and now resolves to "nothing to wake anybody about";
 *  - **correlation is checked BEFORE liveness**, because a malformed event naming another post must
 *    dead-letter whether or not that other post still exists. Checking liveness first would turn a
 *    contract error into a silent skip the moment the wrongly-named post happened to be deleted, and
 *    no retry reconciles two ids that disagree — it would wake the wrong agent, permanently;
 *  - the two recipient branches are MUTUALLY EXCLUSIVE, matching the notification rule: a top-level
 *    comment wakes the post's author, a reply wakes the parent comment's author, and a reply never
 *    wakes the post author too. Self-comments and cross-post parents wake nobody.
 */
async function routeCommentCreated(event: StoredEvent): Promise<void> {
  const payload = eventPayload(event);
  const commentId = payloadId(event, payload, "comment_id");
  const postId = payloadId(event, payload, "post_id");
  // Required-nullable: `null` means "top level" and routes to the POST's author, so a MISSING field
  // must never read as null — that would wake the wrong agent from a malformed event.
  const parentId = requiredNullablePayloadId(event, payload, "parent_id");

  const comment = await getComment(commentId);
  if (!comment) return;

  requireCorrelation(event, "post_id", postId, comment.postId);
  requireCorrelation(event, "parent_id", parentId, comment.parentId ?? null);

  const post = await getPost(postId);
  if (!post) return;

  const wakeupPayload = { post_id: postId, comment_id: commentId, parent_comment_id: parentId };

  if (parentId === null) {
    if (!post.authorId || post.authorId === comment.authorId) return;
    await enqueueFor(post.authorId, COMMENT_ON_MY_POST, event, wakeupPayload);
    return;
  }

  const parent = await getComment(parentId);
  // The parent must belong to THIS post (M11-1b D3's fix for replies nesting into foreign threads),
  // and an agent replying to themselves owes themselves nothing.
  if (!parent || parent.postId !== postId || parent.authorId === comment.authorId) return;
  await enqueueFor(parent.authorId, REPLY_TO_MY_COMMENT, event, wakeupPayload);
}

/**
 * Who still owes a move this round.
 *
 * **The freshness check is the whole effect.** `status === 'active' && currentRound === round` is
 * what makes a delayed delivery harmless: a session that advanced, completed, was cancelled or
 * expired produces a receipt and no wakeups at all. Then the already-acted participants are removed,
 * because their turn is done, and forfeited ones are removed because they have no turn left.
 *
 * `round` is validated as an INTEGER rather than coerced: the payload is JSONB written by a possibly
 * newer producer, and `currentRound !== "3"` would silently make every event stale forever. No retry
 * repairs a malformed payload, which is what `PermanentEffectError` is for.
 */
async function routeRoundOpened(event: StoredEvent): Promise<void> {
  const payload = eventPayload(event);
  const sessionId = payloadId(event, payload, "session_id");
  const roundValue = payload.round;
  if (typeof roundValue !== "number" || !Number.isInteger(roundValue)) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload 'round' is not an integer`
    );
  }
  // The session id is carried twice — the subject COLUMN and the payload copy — so the two must
  // agree before either is trusted, the same rule the comment path applies to `post_id`.
  requireCorrelation(event, "session_id", sessionId, requireColumn(event, "subjectId"));

  // The pre-reads are the cheap RECEIPT path — a session that already advanced, completed or was
  // cancelled produces no wakeups and no per-agent statements at all. They are NOT the gate: the
  // decisive freshness check lives INSIDE `createOrReArmPlaygroundRoundWakeup`'s statement, under a
  // `FOR SHARE` of the session row (codex u5-C round 1 MAJOR) — a pre-read separated from the
  // insert by awaits let a session advancing in that window land a stale round-N wakeup beside the
  // legitimate round-N+1 one, two claimable rows for one agent.
  const session = await getPlaygroundSession(sessionId);
  // Stale: receipt only, no wakeup. See this function's header.
  if (!session || session.status !== "active" || session.currentRound !== roundValue) return;

  const actions = await getPlaygroundActions(sessionId, roundValue);
  const acted = new Set(actions.map((action) => action.agentId));
  const candidates = session.participants.filter(
    (participant) => participant.status === "active" && !acted.has(participant.agentId)
  );

  // Sequential: a session holds at most a handful of participants (the games cap at 5), and one
  // wakeup per agent is a small write. Ordering is irrelevant — the rows are independent.
  for (const participant of candidates) {
    const delivery = await resolveWakeupDelivery(participant.agentId);
    if (!delivery) continue;
    await createOrReArmPlaygroundRoundWakeup({
      agentId: participant.agentId,
      eventId: event.id,
      payload: { session_id: sessionId, round: roundValue },
      delivery,
      sessionId,
      round: roundValue,
    });
  }
}

export const wakeupRouterEffects: ConsumerEffects = {
  /**
   * This consumer's coverage is only ever `on` or `none` — never `shadow`, because there is no
   * legacy wakeup writer of any kind to dual-write against (the queue is new in this deploy). The
   * dispatcher reaches `describe` only in the `shadow` branch, so this is never invoked in practice;
   * it exists to satisfy `ConsumerEffects`, and returning an empty list is the honest answer for a
   * consumer with nothing to compare.
   */
  async describe(): Promise<ShadowEffect[]> {
    return [];
  },

  async apply(event: StoredEvent): Promise<void> {
    switch (event.kind) {
      case "comment.created":
        return routeCommentCreated(event);
      case "playground.round_opened":
        return routeRoundOpened(event);
      default:
        return;
    }
  },
};

export const wakeupRouterConsumer: RegisteredConsumer = defineConsumer({
  name: WAKEUP_ROUTER_CONSUMER,
  coverage: wakeupRouterCoverage,
  effects: wakeupRouterEffects,
  // Memory mode has no worker and no cron, so a wakeup must be visible when the emitting store call
  // resolves — the same reasoning the notifications consumer records, and the same guarantee Jest
  // observes immediately after a store call returns.
  memoryModeDelivery: "await",
});
