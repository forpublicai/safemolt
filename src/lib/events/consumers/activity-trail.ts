/**
 * M11-2 P2.1 — the activity-trail consumer.
 *
 * The outbox is authoritative for agent-initiated actions; the public trail is a **projection**
 * (Decision 5). This consumer replaces the inline `record*ActivityEvent` invocations for train a1's
 * kinds, and it calls the *throwing*, locked-target, source-event-stamped store path rather than
 * the swallowing public wrappers — a swallowed failure would let the drain advance past a projection
 * that never landed and blind the retry ledger entirely.
 *
 * Externally-ingested school/AO events keep writing `activity_events` directly (Decision 5's
 * documented exception) and have no event kind at all, so nothing here touches them.
 */
import {
  applyCommentActivityFromEvent,
  applyFollowActivityFromEvent,
  applyGroupJoinActivityFromEvent,
  applyPlaygroundActionActivityFromEvent,
  applyPlaygroundSessionActivityFromEvent,
  applyPostActivityFromEvent,
  deletePostActivityProjections,
  describeCommentActivityProjection,
  describeFollowActivityProjection,
  describeGroupJoinActivityProjection,
  describePlaygroundActionActivityProjection,
  describePlaygroundSessionActivityProjection,
  describePostActivityProjection,
  getAgentById,
  getComment,
  getGroup,
  getPost,
  readActivityProjectionByKey,
  resolvePlaygroundActionIdByTriple,
  type ActivityTwinSubject,
  type CommentActivityInput,
  type FollowActivityInput,
  type GroupJoinActivityInput,
  type PostActivityInput,
} from "@/lib/store";
import type { StoredEvent } from "@/lib/store-types";

import { activityTrailCoverage } from "./coverage";
import {
  defineConsumer,
  eventPayload,
  payloadId,
  payloadIdList,
  requireColumn,
  requireCorrelation,
  requiredNullablePayloadId,
  type ConsumerEffects,
  type RegisteredConsumer,
  type ShadowEffect,
} from "./dispatch";
import type { LegacyTwin } from "./legacy-compare";

const ACTIVITY_TRAIL_CONSUMER = "activity-trail";

/** Named once because six kinds share one projection — see `planPlaygroundSessionActivity`. */
const PLAYGROUND_SESSION_VOLATILE_FIELDS = ["actor_name", "actor_canonical_name", "search_text"];

/**
 * The upsert's natural key, which is also the shadow `effect_key`: `{kind}:{entity_id}`.
 *
 * It already exists on the legacy side — the inline writers target the same `(kind, entity_id)`
 * unique index — so the soak is comparable without any transitional alignment.
 */
function activityEffectKey(kind: string, entityId: string): string {
  return `${kind}:${entityId}`;
}

/**
 * One planned projection: its natural key, the FULL row it would write, and the write itself.
 *
 * `describe` returns the canonical row rather than a summary of its inputs, and it is produced by
 * the same SELECT `apply` writes through (`describe*ActivityProjection` in the store) — the soak
 * diffs canonical payloads per key, so a consumer that described one row and wrote another would
 * pass verification and then publish the wrong thing.
 */
interface PlannedActivity {
  key: string;
  describe(): Promise<Record<string, unknown> | null>;
  apply(sourceEventId: number): Promise<void>;
}

async function planPostActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const postId = payloadId(event, eventPayload(event), "post_id");
  // Re-fetch: the projection is built from the post's own current fields, and `getPost` hides a
  // tombstone. The locked target inside the upsert is what makes this safe against a delete that
  // commits between here and the write; this read only saves the round trip when it already has.
  const post = await getPost(postId);
  if (!post) return null;
  const input: PostActivityInput = {
    id: post.id,
    authorId: post.authorId,
    groupId: post.groupId,
    title: post.title,
    content: post.content,
    url: post.url,
    createdAt: post.createdAt,
  };
  return {
    key: activityEffectKey("post", post.id),
    describe: () => describePostActivityProjection(input) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyPostActivityFromEvent(input, sourceEventId),
  };
}

async function planCommentActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const payload = eventPayload(event);
  const commentId = payloadId(event, payload, "comment_id");
  const comment = await getComment(commentId);
  if (!comment) return null;
  // Existence is not correlation — see `requireCorrelation`. A live comment that belongs to another
  // post would be projected onto this post's trail row title and href.
  requireCorrelation(event, "post_id", payloadId(event, payload, "post_id"), comment.postId);
  requireCorrelation(
    event,
    "parent_id",
    requiredNullablePayloadId(event, payload, "parent_id"),
    comment.parentId ?? null
  );
  const input: CommentActivityInput = {
    id: comment.id,
    postId: comment.postId,
    authorId: comment.authorId,
    content: comment.content,
    createdAt: comment.createdAt,
    parentId: comment.parentId,
  };
  return {
    key: activityEffectKey("comment", comment.id),
    describe: () => describeCommentActivityProjection(input) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyCommentActivityFromEvent(input, sourceEventId),
  };
}

/**
 * The follow projection. Its subject — the entity the trail row is *about* — is the followee, so
 * that is the agent row the store path locks and the agent whose absence skips the effect.
 */
async function planFollowActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const followerId = requireColumn(event, "actorAgentId");
  const followeeId = requireColumn(event, "subjectId");
  const followee = await getAgentById(followeeId);
  if (!followee) return null;
  const input: FollowActivityInput = {
    followerId,
    followeeId,
    followeeName: followee.name,
    followeeDisplayName: followee.displayName,
    createdAt: event.createdAt,
  };
  const entityId = `${followerId}:${followeeId}`;
  return {
    key: activityEffectKey("follow", entityId),
    describe: () => describeFollowActivityProjection(input) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyFollowActivityFromEvent(input, sourceEventId),
  };
}

/**
 * The group-join projection (M11-2 P1.3). Its subject — the entity the trail row is *about* — is the
 * GROUP, so that is the row the store path locks and the group whose absence skips the effect.
 *
 * `occurred_at` comes from the EVENT, not from the membership row: Postgres keeps
 * `group_members.joined_at` but the memory store has no per-member timestamp at all, so the event's
 * `created_at` is the one instant both stores can project. The transitional inline writer takes the
 * same value from the same statement, which is how the kind cleared
 * `OCCURRED_AT_STAMP_PENDING_KINDS`.
 */
async function planGroupJoinActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const agentId = requireColumn(event, "actorAgentId");
  const groupId = requireColumn(event, "subjectId");
  const group = await getGroup(groupId);
  if (!group) return null;
  const input: GroupJoinActivityInput = {
    agentId,
    groupId: group.id,
    groupName: group.name,
    groupDisplayName: group.displayName,
    createdAt: event.createdAt,
  };
  return {
    key: activityEffectKey("group_join", `${agentId}:${group.id}`),
    describe: () =>
      describeGroupJoinActivityProjection(input) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyGroupJoinActivityFromEvent(input, sourceEventId),
  };
}

/**
 * The playground SESSION projection — the effect SIX kinds share (M11-2 P1.4).
 *
 * Creation, join, affiliation refresh, completion, cancellation and expiry all move the same trail
 * row, and the legacy inline writer rebuilds it from the live session for every one of them. So this
 * is one plan keyed on the subject column, not six.
 *
 * **Cancellation and expiry are UPSERTS here, not deletions**, and that is deliberate: P2.1's prose
 * calls them deletion effects, but since M11-1 C3 neither store deletes the session — both
 * transition it to `cancelled`, and the upsert's `title` (`{game} {status}`) and `metadata.status`
 * carry that word. Removing the row would delete a projection the current product keeps
 * (inventory §7, "Plan drift").
 *
 * A session that is genuinely gone (hard-deleted by a fixture or an operator path) describes as
 * nothing and applies nothing — the drain receipts it, which is the right answer for an absent
 * subject.
 */
async function planPlaygroundSessionActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const sessionId = requireColumn(event, "subjectId");
  return {
    key: activityEffectKey("playground_session", sessionId),
    describe: () =>
      describePlaygroundSessionActivityProjection(sessionId) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyPlaygroundSessionActivityFromEvent(sessionId, sourceEventId),
  };
}

/**
 * The playground ACTION projection, resolved from the event's `(session_id, round, agent_id)` triple.
 *
 * The event carries no action id on purpose (`EventPayloadMap`), so the row is resolved by its own
 * unique key at consume time. An unresolvable triple means the action row is gone — a hard-deleted
 * session cascades its actions away — and the consumer then plans nothing.
 */
async function planPlaygroundActionActivity(event: StoredEvent): Promise<PlannedActivity | null> {
  const payload = eventPayload(event);
  const sessionId = payloadId(event, payload, "session_id");
  const agentId = payloadId(event, payload, "agent_id");
  const round = Number((payload as { round?: unknown }).round);
  if (!Number.isFinite(round)) return null;
  // Existence is not correlation: the event's session must be the one the subject column names, or
  // the trail row would be built from a triple that belongs to a different session's history.
  requireCorrelation(event, "session_id", sessionId, requireColumn(event, "subjectId"));
  const actionId = await resolvePlaygroundActionIdByTriple({ sessionId, round, agentId });
  if (!actionId) return null;
  return {
    key: activityEffectKey("playground_action", actionId),
    describe: () =>
      describePlaygroundActionActivityProjection(actionId) as Promise<Record<string, unknown> | null>,
    apply: (sourceEventId) => applyPlaygroundActionActivityFromEvent(actionId, sourceEventId),
  };
}

async function plan(event: StoredEvent): Promise<PlannedActivity | null> {
  switch (event.kind) {
    case "post.created":
      return planPostActivity(event);
    case "comment.created":
      return planCommentActivity(event);
    case "agent.followed":
      return planFollowActivity(event);
    case "group.joined":
      return planGroupJoinActivity(event);
    case "playground.session_created":
    case "playground.session_joined":
    case "playground.participant_affiliation_updated":
    case "playground.session_completed":
    case "playground.session_cancelled":
    case "playground.session_expired":
      return planPlaygroundSessionActivity(event);
    case "playground.action_submitted":
      return planPlaygroundActionActivity(event);
    default:
      return null;
  }
}

/**
 * The live row the twin read re-locks — the SAME subject each kind's projection SELECT locks
 * (u4prep2 finding 3).
 *
 * Derived from the EVENT and the effect key, never from a re-fetch: a re-fetch is exactly the
 * check-then-read gap this closes. The entity id in the key IS the subject for five of the seven
 * plans, and the two whose entity id is a colon-joined pair (`follow`, `group_join`) carry their
 * subject in the event's own `subject_id` column.
 */
function twinSubject(event: StoredEvent, entityId: string): ActivityTwinSubject | null {
  switch (event.kind) {
    case "post.created":
      return { type: "post", id: entityId };
    case "comment.created":
      return { type: "comment", id: entityId };
    case "agent.followed":
      return { type: "agent", id: requireColumn(event, "subjectId") };
    case "group.joined":
      return { type: "group", id: requireColumn(event, "subjectId") };
    case "playground.session_created":
    case "playground.session_joined":
    case "playground.participant_affiliation_updated":
    case "playground.session_completed":
    case "playground.session_cancelled":
    case "playground.session_expired":
      return { type: "playground_session", id: entityId };
    case "playground.action_submitted":
      return { type: "playground_action", id: entityId };
    default:
      return null;
  }
}

/**
 * The effects, exported beside the consumer — see the note in `notifications.ts`: every checked-in
 * manifest is `legacy` or `none` in u2, so the gates drive these directly with synthetic events and
 * build forced-`on` registry copies from them.
 */
export const activityTrailEffects: ConsumerEffects = {
  /**
   * Volatile presentation fields — see `ConsumerEffects.volatileShadowFields`.
   *
   * `actor_name` and `actor_canonical_name` come straight from the live `agents` row, and
   * `search_text` embeds the actor's display name alongside the content, so all three move when an
   * agent renames between the inline write and the drain. What stays compared for post and comment
   * is everything that matters: `kind`, `entity_id`, `actor_id`, `occurred_at`, the `title` and
   * `summary` built from the content, the id-built `href`, and the whole `metadata` object.
   *
   * `agent.followed` drops more, and has to: a follow projection is ENTIRELY presentation — its
   * title, summary and href are "{display} followed {display}" and `/u/{name}`. `kind`,
   * `entity_id` (the `follower:followee` pair), `actor_id`, `occurred_at` and `metadata` (which
   * carries the followee's id) remain, and they are the whole structural content of that row.
   */
  volatileShadowFields: {
    "post.created": ["actor_name", "actor_canonical_name", "search_text"],
    "comment.created": ["actor_name", "actor_canonical_name", "search_text"],
    "agent.followed": [
      "actor_name",
      "actor_canonical_name",
      "search_text",
      "title",
      "summary",
      "href",
      // `metadata` is otherwise structural, but this ONE field inside it is not: it is the
      // followee's NAME, re-read from the live agent row by whichever writer runs. A rename between
      // the inline write and the drain moves it while `metadata.followee_id` beside it stays put —
      // so the id is compared and the name is not.
      "metadata.followee_name",
    ],
    /**
     * A join row's `title` and `summary` are `"{actor} joined g/{group}"` — **both halves are
     * live-read presentation**, the actor's display name from the `agents` row and the group's from
     * the `groups` row, so an agent rename or a settings edit between the inline write and the
     * drain moves them while nothing about the join changed. Same shape as the follow row, one
     * field shorter.
     *
     * What stays compared is the whole structural content: `kind`, `entity_id` (the
     * `agent:group` pair), `actor_id`, `occurred_at`, the id-built `href` — `/g/{name}`, and a
     * group's canonical name has no rename path at all — and `metadata`, which carries the group's
     * id beside it. Unlike the follow row, `metadata` needs no per-path exclusion for the same
     * reason: `metadata.group_name` cannot move.
     */
    "group.joined": ["actor_name", "actor_canonical_name", "search_text", "title", "summary"],
    /**
     * The playground rows' volatile fields, and they need naming one by one because the two rows
     * differ.
     *
     * A SESSION row's actor is `participants[0]` — its display name is re-read from the live
     * `agents` row on every write, and `search_text` embeds it. Everything structural stays
     * compared: `kind`, `entity_id`, `actor_id`, `occurred_at`, the `{game} {status}` title (which
     * is what makes cancellation visible), the id-built `href`, the summary's participant count and
     * the whole `metadata` object with its `status` and `participants`.
     *
     * An ACTION row's `title` and `summary` both begin with the actor's display name, so both move
     * on a rename while nothing about the action changed — one field more than the session row.
     * `context_hint` (the action's own content), `metadata` and `occurred_at` stay compared.
     */
    "playground.session_created": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.session_joined": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.participant_affiliation_updated": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.session_completed": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.session_cancelled": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.session_expired": PLAYGROUND_SESSION_VOLATILE_FIELDS,
    "playground.action_submitted": [
      "actor_name",
      "actor_canonical_name",
      "search_text",
      "title",
      "summary",
    ],
  },

  async describe(event: StoredEvent): Promise<ShadowEffect[]> {
    if (event.kind === "post.deleted") {
      // **KEY-ONLY, and derived from the PAYLOAD rather than from current state.**
      //
      // One shadow row per trail row that would be removed, under its own natural key — a single
      // `post_delete:{post_id}` blob could not distinguish a consumer that removes the post's row
      // AND its whole thread from one that removes the wrong rows. But the keys cannot come from
      // reading `activity_events`: in the deployed ordering the legacy inline delete commits FIRST
      // and this event drains afterwards, so a live read describes an empty set on every real
      // deletion and the soak reads clean while proving nothing. The payload's `comment_ids` are
      // what the deleting batch saw, so they reconstruct the key set no matter when this runs.
      //
      // There is no canonical PAYLOAD to compare for a deletion: the rows are gone, so their
      // content cannot be diffed by either side. The flip precondition for these kinds is the
      // both-orders convergence gates, not a payload diff (see `coverage.ts`).
      const payload = eventPayload(event);
      const postId = payloadId(event, payload, "post_id");
      const commentIds = payloadIdList(event, payload, "comment_ids");
      return [
        { key: activityEffectKey("post", postId), payload: { operation: "delete", kind: "post", entity_id: postId } },
        ...commentIds.map((commentId) => ({
          key: activityEffectKey("comment", commentId),
          payload: { operation: "delete", kind: "comment", entity_id: commentId },
        })),
      ];
    }
    const planned = await plan(event);
    if (!planned) return [];
    const projection = await planned.describe();
    return projection ? [{ key: planned.key, payload: projection }] : [];
  },

  /**
   * The legacy twin, by the natural key both writers upsert on (u4-prep).
   *
   * **Three answers, decided by the stamped watermark, because every key here is REUSABLE IN PLACE.**
   * All of these kinds upsert on `(kind, entity_id)`, and six playground kinds share one key outright
   * (`playground_session:{id}`), so between an event's inline write and its drain the row may already
   * have been rewritten by a later event of the same or a different kind:
   *
   *  - `source_event_id = event.id` — this event's own row. Compare the payloads.
   *  - `source_event_id > event.id` — a LATER event owns the row now. `superseded`, and
   *    non-verdict-bearing: both writers behaved correctly, the newer write is exactly what the
   *    monotonic guard is for, and a content diff here would measure two different intents. Stamping
   *    `legacy_missing` made a routine join-then-cancel sequence permanently un-clean (u4prep2
   *    finding 1).
   *  - absent, or `source_event_id` older (or NULL, which `COALESCE(…, 0)` orders below every event)
   *    — nothing this event wrote is on disk and nothing newer replaced it, so the inline writer
   *    never landed for this event. `legacy_missing`, verdict-bearing.
   *
   * **The subject is re-validated and LOCKED by the read itself** (u4prep2 finding 3). `describe`'s
   * lock ends with its query, so a deletion landing between the two statements removes the trail row
   * correctly and left this lookup calling that an anomaly. A subject that is gone answers
   * `unverifiable`; only a LIVE subject with no row of its own is `legacy_missing`.
   *
   * The key is split on the FIRST colon only: `follow` and `group_join` entity ids are themselves
   * colon-joined pairs.
   */
  async readLegacyTwin(event: StoredEvent, effectKey: string): Promise<LegacyTwin> {
    if (event.kind === "post.deleted") {
      // Key-only by construction: the trail rows this event removes are gone on both sides.
      return {
        state: "unverifiable",
        reason: "deletion effect: the rows are already removed on both sides, so nothing is diffable",
      };
    }
    const separator = effectKey.indexOf(":");
    if (separator <= 0) return { state: "missing", detail: { effect_key: effectKey } };
    const entityId = effectKey.slice(separator + 1);
    const subject = twinSubject(event, entityId);
    if (!subject) {
      return { state: "unverifiable", reason: `no twin subject is defined for kind '${event.kind}'` };
    }
    const read = await readActivityProjectionByKey(effectKey.slice(0, separator), entityId, subject);
    if (read.state === "subject_gone") {
      return {
        state: "unverifiable",
        reason: `the ${subject.type} this trail row is about was deleted before the twin read`,
      };
    }
    if (read.state === "missing") return { state: "missing", detail: { effect_key: effectKey } };
    const legacy = read.row;
    if (legacy.sourceEventId !== null && legacy.sourceEventId > event.id) {
      return {
        state: "superseded",
        detail: {
          effect_key: effectKey,
          reason: "a later event has since rewritten the legacy row at this reusable key",
          legacy_source_event_id: legacy.sourceEventId,
        },
      };
    }
    if (legacy.sourceEventId !== event.id) {
      return {
        state: "missing",
        detail: {
          effect_key: effectKey,
          reason: "the legacy row at this key stopped at an earlier event",
          legacy_source_event_id: legacy.sourceEventId,
        },
      };
    }
    return { state: "row", payload: legacy.projection as unknown as Record<string, unknown> };
  },

  async apply(event: StoredEvent): Promise<void> {
    if (event.kind === "post.deleted") {
      // The post's trail row, its comments' trail rows, and every cached context for them — the
      // convergence half that `post.created`'s locked target cannot provide, because it only stops
      // a projection from being written, never removes one that already was.
      await deletePostActivityProjections(payloadId(event, eventPayload(event), "post_id"));
      return;
    }
    const planned = await plan(event);
    // No plan means the subject is gone: receipt, no row. The drain treats that as success, which
    // is what makes delete-then-create converge instead of resurrecting the post.
    if (planned) await planned.apply(event.id);
  },
};

export const activityTrailConsumer: RegisteredConsumer = defineConsumer({
  name: ACTIVITY_TRAIL_CONSUMER,
  coverage: activityTrailCoverage,
  effects: activityTrailEffects,
  // The trail row must exist when the emitting store call resolves — memory-mode tests read the
  // activity feed immediately afterwards, exactly as they do against today's inline writers.
  memoryModeDelivery: "await",
});
