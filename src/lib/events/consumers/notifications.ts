/**
 * M11-2 P2.1 — the notifications consumer.
 *
 * It replaces six inline notification writer sites across four store files (inventory §9c), and its
 * producers are exactly train a1's mutations: comment, reply, follow — plus `post.deleted`, whose
 * effect runs the other way.
 *
 * **Content-anchored effects re-fetch their subject AND write through a locked target.** The
 * re-fetch decides whether there is anything to do; the lock inside the insert is what makes the
 * decision hold. The pipeline is at-least-once and delayed, so a consumer can read the post live,
 * pause, have `post.deleted` and its cleanup complete, then resume — and a check-then-write insert
 * would manufacture a fresh dead-link notification the cleanup can never reach again. The mirror
 * direction — consume-before-delete — is what the `post.deleted` convergence effect below closes,
 * because `notifications` has no FK to posts or comments and nothing else would remove those rows.
 */
import {
  createCommentNotificationIdempotent,
  createFollowNotificationIdempotent,
  createPlaygroundRoundOpenNotificationIdempotent,
  deleteNotificationsAnchoredToPost,
  describeCommentNotification,
  describeFollowNotification,
  getComment,
  getPlaygroundActions,
  getPlaygroundSession,
  getPost,
  readNotificationProjectionByDedupKey,
  type CommentNotificationInput,
  type FollowNotificationInput,
  type NotificationTwinSubject,
} from "@/lib/store";
import type { NotificationType, StoredEvent } from "@/lib/store-types";

import { PermanentEffectError } from "../errors";
import { notificationsCoverage } from "./coverage";
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
import type { LegacyTwin } from "./legacy-compare";

const NOTIFICATIONS_CONSUMER = "notifications";

/**
 * The dedup key: `{type}:{recipient_agent_id}:{event_id}` (Decision 6).
 *
 * **Event-keyed, never content-keyed.** A second comment by the same actor on the same post is a
 * different event and therefore a new notification; re-consuming one event is not. It is also the
 * shadow soak's `effect_key`, and P1.2's transitional inline writer stamps the same string, so
 * legacy rows and shadow rows share keys by construction.
 */
function notificationDedupKey(
  type: NotificationType,
  recipientAgentId: string,
  eventId: number
): string {
  return `${type}:${recipientAgentId}:${eventId}`;
}

/**
 * One planned insert. The store input carries its own dedup key.
 *
 * The key is narrowed to non-null here, and that is the consumer's own guarantee rather than the
 * store's: the store's inputs admit `null` for a transitional inline writer whose caller emitted no
 * event (M11-2 P1.2), but a consumer always has the event in hand — and the key is also the shadow
 * `effect_key`, which cannot be null.
 */
type PlannedNotification =
  | { kind: "comment"; input: CommentNotificationInput & { dedupKey: string } }
  | { kind: "follow"; input: FollowNotificationInput & { dedupKey: string } };

/**
 * Recipients exactly as today's inline writer derives them (`src/lib/store/comments/db.ts`).
 *
 * **The two types are mutually exclusive, and that is the legacy contract, not an oversight.** The
 * inline batch picks its element on `parentId === undefined`: a top-level comment notifies the post
 * author, a reply notifies the parent comment's author, and a reply never notifies the post author.
 * Producing both here would make every shadow comparison for a reply a mismatch and would double
 * the notifications an agent receives the moment the kind flips to `on`.
 *
 * Self-notification is excluded on both branches, exactly as the inline `<>` predicates do — and
 * re-asserted inside the store's statement, which does not trust this read.
 */
async function planCommentNotification(event: StoredEvent): Promise<PlannedNotification | null> {
  const payload = eventPayload(event);
  const commentId = payloadId(event, payload, "comment_id");
  const postId = payloadId(event, payload, "post_id");
  // Required-nullable: `null` means "top level" and routes to the POST's author, so a MISSING field
  // must never be read as null — that would notify the wrong agent from a malformed event.
  const parentId = requiredNullablePayloadId(event, payload, "parent_id");

  // Re-fetch, and skip a missing subject. `getComment` and `getPost` both hide a deleted post's
  // rows, so a delete that landed between the event and now resolves to "nothing to notify about".
  const comment = await getComment(commentId);
  if (!comment) return null;

  // **Correlation BEFORE liveness, and the order is the point.** A malformed event naming another
  // post must dead-letter whether or not that other post still exists — checking liveness first
  // would turn a contract error into a silent skip the moment the wrongly-named post happened to be
  // deleted, and the malformed producer would never be found. Neither disagreement is recoverable
  // by retrying: a comment on another post would notify THIS post's author about a comment that is
  // not on their post, and a wrong `parent_id` would route a reply to an unrelated commenter.
  requireCorrelation(event, "post_id", postId, comment.postId);
  requireCorrelation(event, "parent_id", parentId, comment.parentId ?? null);

  // Only now is a missing post a liveness skip rather than a contract error.
  const post = await getPost(postId);
  if (!post) return null;

  const base = {
    actorAgentId: comment.authorId,
    postId,
    commentId,
    parentCommentId: parentId,
    createdAt: comment.createdAt,
  };

  if (parentId === null) {
    if (!post.authorId || post.authorId === comment.authorId) return null;
    return {
      kind: "comment",
      input: {
        ...base,
        type: "comment_on_my_post",
        recipientAgentId: post.authorId,
        dedupKey: notificationDedupKey("comment_on_my_post", post.authorId, event.id),
      },
    };
  }

  const parent = await getComment(parentId);
  // The inline writer also requires the parent to belong to THIS post (`pc.post_id = postId`) —
  // M11-1b D3's fix for replies nesting into foreign threads. The same check, at the same place,
  // and again inside the statement that writes.
  if (!parent || parent.postId !== postId || parent.authorId === comment.authorId) return null;
  return {
    kind: "comment",
    input: {
      ...base,
      type: "reply_to_my_comment",
      recipientAgentId: parent.authorId,
      dedupKey: notificationDedupKey("reply_to_my_comment", parent.authorId, event.id),
    },
  };
}

/**
 * `new_follower` to the followee (`followAgent` in `src/lib/store/agents/db.ts`).
 *
 * Both agents come from the event COLUMNS: actor is the follower, subject is the followee. Only a
 * missing FOLLOWEE suppresses the row: the store's insert requires the recipient but takes the
 * follower through a left join and falls back to the raw id, because a withdrawn follower must not
 * erase a notification the followee already earned (the pinned withdrawn-follower fixture).
 *
 * The event's own timestamp becomes the row's `created_at`: the follow row carries no timestamp the
 * consumer can read back, and the event was stamped by the statement that committed the follow.
 */
function planFollowNotification(event: StoredEvent): PlannedNotification | null {
  const followerId = requireColumn(event, "actorAgentId");
  const followeeId = requireColumn(event, "subjectId");
  if (followerId === followeeId) return null;
  return {
    kind: "follow",
    input: {
      recipientAgentId: followeeId,
      actorAgentId: followerId,
      createdAt: event.createdAt,
      dedupKey: notificationDedupKey("new_follower", followeeId, event.id),
    },
  };
}

async function plan(event: StoredEvent): Promise<PlannedNotification | null> {
  switch (event.kind) {
    case "comment.created":
      return planCommentNotification(event);
    case "agent.followed":
      return planFollowNotification(event);
    default:
      return null;
  }
}

/**
 * The live row the twin read re-locks — the SAME subject each insert locks (u4prep2 finding 3).
 *
 * It comes from the EVENT, never from a re-fetch: a re-fetch is the very check-then-read gap this
 * closes, and both ids are carried by the event itself (`post_id` in the payload, the followee in
 * the subject column).
 */
function twinSubject(event: StoredEvent): NotificationTwinSubject | null {
  switch (event.kind) {
    case "comment.created":
      return { type: "post", id: payloadId(event, eventPayload(event), "post_id") };
    case "agent.followed":
      return { type: "agent", id: requireColumn(event, "subjectId") };
    default:
      return null;
  }
}

/**
 * The MARKABLE round-open row, one per participant who still owes a move (M11-2 P3.2, train a4).
 *
 * **A separate effect from the wakeup router's, on the same event and the same predicate.** One
 * owner per projection: this consumer writes the inbox row, the router writes the wakeup, and
 * neither touches the other's table. They have separate cursors and separate retry ledgers, so a
 * failure in one never duplicates or stalls the other.
 *
 * **It is not planned through `plan()`, deliberately.** `plan` answers ONE `PlannedNotification` per
 * event and this kind fans out over a participant list, so folding it in would have to widen a shape
 * a long tail of a1 gates depends on. `plan()`'s `switch` therefore has no case for this kind and
 * returns `null`, which is exactly right: `describe` is never invoked for an `on` kind with no
 * legacy writer, and if it ever were it would harmlessly return `[]` rather than dead code.
 *
 * Freshness is re-checked here AND inside each insert. This check decides whether there is anything
 * to do; the insert's locked subject — the session, still active on exactly this round — is what
 * makes the decision hold against a GM advancing the round in between.
 */
async function applyPlaygroundRoundOpenNotifications(event: StoredEvent): Promise<void> {
  const payload = eventPayload(event);
  const sessionId = payloadId(event, payload, "session_id");
  const roundValue = payload.round;
  // JSONB written by a possibly-newer producer: a non-integer round would make every comparison
  // below false and silently swallow the kind forever. No retry repairs a malformed payload.
  if (typeof roundValue !== "number" || !Number.isInteger(roundValue)) {
    throw new PermanentEffectError(
      `[events] event ${event.id} (${event.kind}) payload 'round' is not an integer`
    );
  }
  requireCorrelation(event, "session_id", sessionId, requireColumn(event, "subjectId"));

  const session = await getPlaygroundSession(sessionId);
  if (!session || session.status !== "active" || session.currentRound !== roundValue) return;
  const actions = await getPlaygroundActions(sessionId, roundValue);
  const acted = new Set(actions.map((action) => action.agentId));
  const candidates = session.participants.filter(
    (participant) => participant.status === "active" && !acted.has(participant.agentId)
  );

  for (const participant of candidates) {
    await createPlaygroundRoundOpenNotificationIdempotent({
      sessionId,
      round: roundValue,
      agentId: participant.agentId,
      createdAt: event.createdAt,
      // The same Decision-6 shape the other two kinds use: `{type}:{recipient}:{event_id}`. The
      // event id is the only correlation the row needs, so re-consuming one event writes nothing
      // while a genuinely new round — a new event — writes a fresh row.
      dedupKey: notificationDedupKey("playground_round_open", participant.agentId, event.id),
    });
  }
}

/**
 * The effects, exported beside the consumer.
 *
 * Every checked-in manifest puts every a1 kind at `legacy` or `none` in u2, so nothing else can
 * reach `describe` or `apply` yet — and an effect nobody can invoke is an effect nobody has tested.
 * The gates drive these directly with synthetic events, and build forced-`on` registry copies from
 * them to exercise the real drain contract before u3's producers exist.
 */
export const notificationEffects: ConsumerEffects = {
  /**
   * Every field here is read from a LIVE agent row at write time, by both writers, at different
   * instants — see `ConsumerEffects.volatileShadowFields`. `actor.id` stays compared, because the
   * identity is structural even when the display of it is not; so do both targets' ids, the href
   * for comment kinds (`/post/{id}#comment-{id}`, built from ids alone) and every metadata id.
   *
   * `agent.followed` additionally drops `target.name` and `href`: the followee's name and the
   * follower-name-built `/u/{name}` link both move when either agent renames, and the follower's
   * href falls back to a raw id the moment they withdraw.
   */
  volatileShadowFields: {
    "comment.created": ["actor.name", "actor.display_name"],
    "agent.followed": ["actor.name", "actor.display_name", "target.name", "href"],
  },

  async describe(event: StoredEvent): Promise<ShadowEffect[]> {
    if (event.kind === "post.deleted") {
      // **One PREDICATE-IDENTITY key, and that is the honest shape for this effect.**
      //
      // The other two consumers can name the rows they remove because the payload carries their
      // ids. Notifications cannot: they have no FK to posts or comments, the effect is a predicate
      // (`metadata->>'post_id' = …`), and the rows it matches are not enumerable from the payload —
      // the deleting batch never saw them. Reading them live is worse than useless: in the deployed
      // ordering the legacy inline delete commits FIRST and this event drains afterwards, so a live
      // read describes an empty set on every real deletion and the soak reads clean while proving
      // nothing.
      //
      // So the key names the PREDICATE, both writers apply the same predicate, and the flip
      // precondition for this kind is the both-orders convergence gates rather than a payload diff
      // (see `coverage.ts`). A canonical payload comparison cannot exist for rows that no longer do.
      const postId = payloadId(event, eventPayload(event), "post_id");
      return [
        {
          key: `notifications-for-post:${postId}`,
          payload: { operation: "delete", predicate: "metadata.post_id", post_id: postId },
        },
      ];
    }

    const planned = await plan(event);
    if (!planned) return [];
    // The canonical row, read through the SAME select that writes it — a right-key/wrong-content
    // consumer must fail verification, so keys alone are not enough.
    const projection =
      planned.kind === "comment"
        ? await describeCommentNotification(planned.input)
        : await describeFollowNotification(planned.input);
    if (!projection) return [];
    return [
      { key: planned.input.dedupKey, payload: projection as unknown as Record<string, unknown> },
    ];
  },

  /**
   * The legacy twin, by the dedup key both writers stamp (u4-prep).
   *
   * The key IS the correlation — `{type}:{recipient}:{event_id}` names this event and nothing else —
   * so no reconstruction of "the key a legitimate producer would have computed" is needed or wanted:
   * a row either sits at this key or does not, and both answers are decided here, seconds after the
   * transitional inline writer committed it inside the emitting statement (P1.2).
   *
   * **The subject is re-locked by the read itself** (u4prep2 finding 3). `describe`'s lock ends with
   * its query, so a deletion landing between the two statements removes the legacy row correctly and
   * left this lookup calling that an anomaly. The store re-validates the same subject in the same
   * query — the comment kinds' post, the follow kind's followee — and a subject that is gone answers
   * `unverifiable` rather than `legacy_missing`.
   */
  async readLegacyTwin(event: StoredEvent, effectKey: string): Promise<LegacyTwin> {
    if (event.kind === "post.deleted") {
      // A deletion has no comparable twin BY CONSTRUCTION — the rows are gone on both sides, and
      // the key names a predicate rather than a row (see `describe`). Its flip precondition is the
      // both-orders convergence gates, not a payload diff.
      return {
        state: "unverifiable",
        reason: "deletion effect: the rows are already removed on both sides, so nothing is diffable",
      };
    }
    const subject = twinSubject(event);
    if (!subject) {
      return { state: "unverifiable", reason: `no twin subject is defined for kind '${event.kind}'` };
    }
    const legacy = await readNotificationProjectionByDedupKey(effectKey, subject);
    if (legacy.state === "subject_gone") {
      return {
        state: "unverifiable",
        reason: `the ${subject.type} this notification is about was deleted before the twin read`,
      };
    }
    if (legacy.state === "missing") return { state: "missing", detail: { dedup_key: effectKey } };
    return { state: "row", payload: legacy.projection as unknown as Record<string, unknown> };
  },

  async apply(event: StoredEvent): Promise<void> {
    if (event.kind === "post.deleted") {
      await deleteNotificationsAnchoredToPost(payloadId(event, eventPayload(event), "post_id"));
      return;
    }
    // Special-cased ahead of `plan()` for the reason `post.deleted` is: this kind's effect is a
    // fan-out over participants, not the single planned insert `plan()` answers with.
    if (event.kind === "playground.round_opened") {
      await applyPlaygroundRoundOpenNotifications(event);
      return;
    }
    const planned = await plan(event);
    if (!planned) return;
    // A conflict — or an empty locked target — returns null, and that is success rather than a
    // failure: either somebody already recorded this effect, or the subject is gone and there is
    // nothing to record. The drain receipts both.
    if (planned.kind === "comment") await createCommentNotificationIdempotent(planned.input);
    else await createFollowNotificationIdempotent(planned.input);
  },
};

export const notificationsConsumer: RegisteredConsumer = defineConsumer({
  name: NOTIFICATIONS_CONSUMER,
  coverage: notificationsCoverage,
  effects: notificationEffects,
  // The inbox must show the notification by the time the emitting store call resolves — that is
  // what today's inline writes provide, and Jest observes it immediately after the call returns.
  memoryModeDelivery: "await",
});
