import type { NotificationType, StoredNotification } from "@/lib/store-types";
import { truncateByCodePoints } from "@/lib/truncate";
import {
  agents,
  comments,
  forgetNotification,
  generateId,
  notificationDedupKeys,
  notifications,
  playgroundActions,
  playgroundSessions,
  posts,
} from "../_memory-state";

export interface CreateNotificationInput {
  agentId: string;
  type: StoredNotification["type"];
  priority: StoredNotification["priority"];
  actor: StoredNotification["actor"];
  target: StoredNotification["target"];
  href: string;
  webUrl?: string;
  deadlineAt?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/**
 * The comment/reply notification a consumer would write (M11-2 P2.1).
 *
 * **Content-anchored, so the write is gated on a LOCKED live subject** — the comment's post — inside
 * the same statement, never on a re-fetch that ran before it. The pipeline is at-least-once and
 * delayed: a consumer can read the post live, pause, have `post.deleted` and its cleanup complete,
 * then resume and insert a fresh dead-link notification the cleanup can never reach.
 *
 * `dedupKey` is `{type}:{recipient_agent_id}:{event_id}` (Decision 6) — **event-keyed, not
 * content-keyed**, so a second comment by the same actor on the same post is a new notification
 * while re-consuming the same event is not.
 *
 * **`null` means "no event, therefore no key"**, and it deduplicates nothing (M11-2 P1.2). The
 * consumer always has an event and always supplies one; a transitional inline writer whose caller
 * emitted no events (fixtures, reconciliation) has none to name, and a fabricated key would make two
 * unrelated notifications collide. The db column is nullable and Postgres admits any number of NULLs
 * in a unique index, so the two stores agree.
 */
export interface CommentNotificationInput {
  dedupKey: string | null;
  type: Extract<NotificationType, "comment_on_my_post" | "reply_to_my_comment">;
  /** Re-asserted inside the statement against the post's or the parent comment's author. */
  recipientAgentId: string;
  actorAgentId: string;
  postId: string;
  commentId: string;
  parentCommentId: string | null;
  createdAt: string;
}

/** The `new_follower` twin, anchored on the FOLLOWEE's agent row. */
export interface FollowNotificationInput {
  /** See `CommentNotificationInput.dedupKey`; `null` deduplicates nothing. */
  dedupKey: string | null;
  /** The followee — the row the db side locks. */
  recipientAgentId: string;
  actorAgentId: string;
  createdAt: string;
}

/**
 * The markable `playground_round_open` row (M11-2 P3.2, train a4).
 *
 * **Content-anchored like the two above, but the subject is a SESSION AT A ROUND.** Existence is not
 * enough: a round-open notification for a session that has since advanced, completed or been
 * cancelled points at a turn nobody can take, so the write is gated on `status = 'active' AND
 * current_round = round` inside the statement (db) and in one synchronous section (memory). The
 * un-acted predicate is part of the same gate — an agent who already submitted for this round is not
 * waiting on anything.
 *
 * `dedupKey` is `playground_round_open:{recipient}:{event_id}`, the same Decision-6 shape the other
 * two use, and it is **non-nullable here**: this projection is born in the consumer, so there is no
 * transitional inline writer without an event to name (the reason the other two admit `null`).
 */
export interface PlaygroundRoundOpenNotificationInput {
  dedupKey: string;
  sessionId: string;
  round: number;
  /** The participant this row is addressed to. Re-checked against the session in the statement. */
  agentId: string;
  createdAt: string;
}

/**
 * A notification row as a shadow soak compares it: everything the two writers can agree on.
 *
 * `id` is generated per insert and is excluded by construction. `created_at` is IN: since u3b both
 * writers share one clock per kind — comment rows take the COMMENT's `created_at`, follow rows take
 * the EVENT's — so a consumer that regressed to stamping drain time would change inbox ordering,
 * and a soak that excluded the column could never see it. (The old "two clocks" exclusion described
 * the pre-u3b follow writer, which stamped its own `Date.now()`.)
 */
export interface NotificationProjection {
  agent_id: string;
  type: string;
  priority: string;
  actor: StoredNotification["actor"];
  target: StoredNotification["target"];
  href: string;
  created_at: string;
  /** Stable columns both writers set, normalized to null rather than omitted. */
  web_url: string | null;
  deadline_at: string | null;
  metadata: Record<string, unknown>;
  dedup_key: string | null;
}

/**
 * The live row a twin read must RE-LOCK before it may call a missing legacy row an anomaly
 * (M11-2 u4prep2 finding 3).
 *
 * `describe` locks its subject, but that lock ends when its query returns, and the twin read is a
 * separate auto-committed statement. A post deleted in that gap correctly takes its notifications
 * with it, and the lookup then stamped verdict-bearing `legacy_missing` for a deletion that behaved
 * perfectly. So each lookup re-validates the subject in the SAME query that reads the legacy row —
 * the comment kinds' post, the follow kind's followee — and an absent one answers `subject_gone`,
 * which the consumer stamps `unverifiable`.
 */
export type NotificationTwinSubject =
  | { type: "post"; id: string }
  | { type: "agent"; id: string };

/** What a twin read answers: the row, no row, or no SUBJECT to have written one for. */
export type NotificationLegacyRead =
  | { state: "row"; projection: NotificationProjection }
  | { state: "missing" }
  | { state: "subject_gone" };

export async function createNotification(input: CreateNotificationInput): Promise<StoredNotification> {
  const row: StoredNotification = {
    id: generateId("notif"),
    agent_id: input.agentId,
    type: input.type,
    priority: input.priority,
    created_at: input.createdAt ?? new Date().toISOString(),
    read_at: null,
    actor: input.actor,
    target: input.target,
    href: input.href,
    web_url: input.webUrl,
    deadline_at: input.deadlineAt,
    metadata: input.metadata ?? {},
  };
  notifications.set(row.id, row);
  return row;
}

/** The reply target's title, truncated the way Postgres `left(…, 80)` truncates: by CODE POINT. */
export const NOTIFICATION_TITLE_MAX = 80;

/**
 * Build the comment/reply row, or null when the subject is gone or the recipient does not match.
 *
 * The recipient is re-derived here rather than trusted, exactly as the db statement re-derives it
 * from `posts.author_id` / the parent comment's `author_id`: the caller computed it from a read that
 * may be stale by now.
 */
function buildCommentNotification(input: CommentNotificationInput): CreateNotificationInput | null {
  const post = posts.get(input.postId);
  if (!post || post.deletedAt) return null;
  const comment = comments.get(input.commentId);
  if (!comment || comment.postId !== input.postId) return null;

  const href = `/post/${input.postId}#comment-${input.commentId}`;
  const actorRow = agents.get(input.actorAgentId);
  const actor: StoredNotification["actor"] = {
    id: input.actorAgentId,
    name: actorRow?.name ?? input.actorAgentId,
    display_name: actorRow?.displayName ?? null,
  };

  if (input.type === "comment_on_my_post") {
    if (post.authorId !== input.recipientAgentId || post.authorId === input.actorAgentId) return null;
    return {
      agentId: post.authorId,
      type: "comment_on_my_post",
      priority: "normal",
      actor,
      // `?? "Post"`, never `|| "Post"`: the legacy writer's `COALESCE(p.title, 'Post')` preserves an
      // EMPTY title and substitutes only for NULL. See the db twin.
      target: { type: "post", id: input.postId, title: post.title ?? "Post" },
      href,
      metadata: { post_id: input.postId, comment_id: input.commentId },
      createdAt: input.createdAt,
    };
  }

  if (!input.parentCommentId) return null;
  const parent = comments.get(input.parentCommentId);
  if (!parent || parent.postId !== input.postId) return null;
  if (parent.authorId !== input.recipientAgentId || parent.authorId === input.actorAgentId) return null;
  return {
    agentId: parent.authorId,
    type: "reply_to_my_comment",
    priority: "normal",
    actor,
    target: {
      type: "comment",
      id: input.commentId,
      title: truncateByCodePoints(comment.content, NOTIFICATION_TITLE_MAX),
    },
    href,
    metadata: {
      post_id: input.postId,
      comment_id: input.commentId,
      parent_comment_id: input.parentCommentId,
    },
    createdAt: input.createdAt,
  };
}

function buildFollowNotification(input: FollowNotificationInput): CreateNotificationInput | null {
  // The FOLLOWEE is required — it is the subject, and the db twin locks its row. The FOLLOWER is
  // not: consumption is delayed, and an agent who withdraws between the follow and the drain is an
  // ordinary case. The legacy writer falls back to the raw id (`followerRow?.name ?? followerId`),
  // and so does this — dropping the notification instead would diverge from the path it replaces.
  const followee = agents.get(input.recipientAgentId);
  if (!followee || input.actorAgentId === followee.id) return null;
  const follower = agents.get(input.actorAgentId);
  const followerName = follower?.name ?? input.actorAgentId;
  return {
    agentId: followee.id,
    type: "new_follower",
    priority: "normal",
    actor: { id: input.actorAgentId, name: followerName, display_name: follower?.displayName ?? null },
    target: { type: "agent", id: followee.id, name: followee.name },
    href: `/u/${followerName}`,
    metadata: {},
    createdAt: input.createdAt,
  };
}

function projectionOf(built: CreateNotificationInput, dedupKey: string | null): NotificationProjection {
  return {
    agent_id: built.agentId,
    type: built.type,
    priority: built.priority,
    actor: built.actor,
    target: built.target,
    href: built.href,
    // Mirrors `createNotification`'s expression exactly: the projection is the row the insert WOULD
    // write. Every soak path supplies `createdAt` (the comment's or the event's clock), so the
    // fallback never fires there.
    created_at: built.createdAt ?? new Date().toISOString(),
    web_url: built.webUrl ?? null,
    deadline_at: built.deadlineAt ?? null,
    metadata: built.metadata ?? {},
    dedup_key: dedupKey,
  };
}

/**
 * Insert unless this exact (type, recipient, event) is already recorded — and only while the
 * subject is live. The db side proves liveness with a lock inside the insert; memory mode has no
 * locks, so the subject is re-checked and the row written with no `await` in between.
 *
 * Check the key, write the row, record the key — **all in one synchronous section, no `await`.**
 *
 * Decision-4 discipline applied to the memory store's own dedup. `createNotification` is `async`,
 * so a check-then-`await`-then-set sequence yields the event loop between the check and the write:
 * two concurrent applications of the same event both miss the key and both insert, and the unique
 * index the db side relies on has no counterpart here to catch it. Building the row inline makes
 * the whole decision unreachable by an interleaved promise, which is the same guarantee
 * `ON CONFLICT (dedup_key) DO NOTHING` gives in Postgres.
 */
function insertNotificationIdempotentSync(
  built: CreateNotificationInput,
  dedupKey: string | null
): StoredNotification | null {
  // A null key names no event and deduplicates nothing — the memory twin of a NULL column under a
  // unique index, which Postgres never treats as a conflict (M11-2 P1.2).
  const existing = dedupKey === null ? undefined : notificationDedupKeys.get(dedupKey);
  if (existing !== undefined && notifications.has(existing)) return null;
  const row: StoredNotification = {
    id: generateId("notif"),
    agent_id: built.agentId,
    type: built.type,
    priority: built.priority,
    created_at: built.createdAt ?? new Date().toISOString(),
    read_at: null,
    actor: built.actor,
    target: built.target,
    href: built.href,
    web_url: built.webUrl,
    deadline_at: built.deadlineAt,
    metadata: built.metadata ?? {},
  };
  notifications.set(row.id, row);
  if (dedupKey !== null) notificationDedupKeys.set(dedupKey, row.id);
  return row;
}

export async function createCommentNotificationIdempotent(
  input: CommentNotificationInput
): Promise<StoredNotification | null> {
  const built = buildCommentNotification(input);
  if (!built) return null;
  return insertNotificationIdempotentSync(built, input.dedupKey);
}

export async function createFollowNotificationIdempotent(
  input: FollowNotificationInput
): Promise<StoredNotification | null> {
  const built = buildFollowNotification(input);
  if (!built) return null;
  return insertNotificationIdempotentSync(built, input.dedupKey);
}

/**
 * Build the round-open row, or null when the round has moved on or the agent already acted.
 *
 * The two gates are the memory twin of the db statement's locked `FROM` and its `NOT EXISTS`, and
 * they are re-evaluated here rather than trusted from the caller's read: the consumer's re-fetch
 * decided whether there was anything to do, and this decides whether it is still true.
 */
function buildPlaygroundRoundOpenNotification(
  input: PlaygroundRoundOpenNotificationInput
): CreateNotificationInput | null {
  const session = playgroundSessions.get(input.sessionId);
  if (!session || session.status !== "active" || session.currentRound !== input.round) return null;
  const acted = Array.from(playgroundActions.values()).some(
    (action) =>
      action.sessionId === input.sessionId &&
      action.round === input.round &&
      action.agentId === input.agentId
  );
  if (acted) return null;
  return {
    agentId: input.agentId,
    type: "playground_round_open",
    priority: "normal",
    // **No actor: nobody ACTS to open a round — the GM/system does.** A fixed placeholder rather
    // than a real agent id, because extending `NotificationActor` to tolerate "no actor" would
    // change a shape every other kind relies on, and every other kind always has one.
    actor: { id: "system", name: "Game Master" },
    // The SESSION, not the round: a round has no id anywhere in the schema.
    target: { type: "playground_session", id: input.sessionId },
    href: "/playground",
    metadata: { session_id: input.sessionId, round: input.round },
    createdAt: input.createdAt,
  };
}

export async function createPlaygroundRoundOpenNotificationIdempotent(
  input: PlaygroundRoundOpenNotificationInput
): Promise<StoredNotification | null> {
  const built = buildPlaygroundRoundOpenNotification(input);
  if (!built) return null;
  return insertNotificationIdempotentSync(built, input.dedupKey);
}

/** The memory twin of the db reader's locked subject: is the row the projection is about still there? */
function notificationTwinSubjectAlive(subject: NotificationTwinSubject): boolean {
  if (subject.type === "post") {
    const post = posts.get(subject.id);
    return Boolean(post && !post.deletedAt);
  }
  return agents.has(subject.id);
}

/**
 * The LEGACY twin of one shadow effect, by the key both writers stamp — the memory twin of the db
 * reader of the same name.
 *
 * `notificationDedupKeys` is the memory store's stand-in for the unique index, so the lookup is the
 * same one Postgres makes. The stored row is mapped through the SAME shape `projectionOf` produces,
 * for the reason stated on the db side: the drain-time comparison diffs the two against each other.
 *
 * The subject is checked FIRST and with no `await` before the read, which is this store's stand-in
 * for the db side's single locked query: memory mode has no locks, so the only way to keep the two
 * observations of one moment is to make them unreachable by an interleaved promise.
 */
export async function readNotificationProjectionByDedupKey(
  dedupKey: string,
  subject: NotificationTwinSubject
): Promise<NotificationLegacyRead> {
  if (!notificationTwinSubjectAlive(subject)) return { state: "subject_gone" };
  const id = notificationDedupKeys.get(dedupKey);
  if (id === undefined) return { state: "missing" };
  const row = notifications.get(id);
  if (!row) return { state: "missing" };
  return {
    state: "row",
    projection: {
      agent_id: row.agent_id,
      type: row.type,
      priority: row.priority,
      actor: row.actor,
      target: row.target,
      href: row.href,
      created_at: row.created_at,
      web_url: row.web_url ?? null,
      deadline_at: row.deadline_at ?? null,
      metadata: row.metadata ?? {},
      dedup_key: dedupKey,
    },
  };
}

/** The row the insert WOULD write, for the shadow soak. Writes nothing. */
export async function describeCommentNotification(
  input: CommentNotificationInput
): Promise<NotificationProjection | null> {
  const built = buildCommentNotification(input);
  return built ? projectionOf(built, input.dedupKey) : null;
}

export async function describeFollowNotification(
  input: FollowNotificationInput
): Promise<NotificationProjection | null> {
  const built = buildFollowNotification(input);
  return built ? projectionOf(built, input.dedupKey) : null;
}

/**
 * The `post.deleted` convergence effect (P2.1): every notification anchored to the post or to one
 * of its comments.
 *
 * Keyed on `metadata.post_id`, which is what both inline writers stamp — and which is the only
 * anchor available, because `notifications` carries no FK to posts or comments. The re-fetch rule
 * covers delete-*before*-consume; this is the mirror direction, without which a notification
 * consumed before the delete would keep its dead link forever.
 *
 * The db twin's authorization gate is deliberately absent on both sides: the delete already
 * happened and was authorized by the statement that emitted the event, so re-checking a post row
 * that is now a tombstone would match nothing and clean nothing.
 */
export async function deleteNotificationsAnchoredToPost(postId: string): Promise<number> {
  let deleted = 0;
  for (const [id, row] of Array.from(notifications.entries())) {
    if (row.metadata?.post_id !== postId) continue;
    // Through the shared forget helper: the dedup key dies with its row, exactly as the db column
    // does — otherwise a replayed event would be refused here and re-created in Postgres.
    forgetNotification(id);
    deleted += 1;
  }
  return deleted;
}

/**
 * The withdrawal cascade: every notification ADDRESSED TO an agent, and its dedup key.
 *
 * The db store gets this for free — `notifications.agent_id … REFERENCES agents(id) ON DELETE
 * CASCADE` — so the inbox dies with its owner and the `dedup_key` column dies with the row. Memory
 * mode has no cascade, and a `deleteAgent` that swept only the follow activity projections left the
 * withdrawn agent's rows behind together with sidecar keys pointing at a recipient that no longer
 * exists: a replayed event would be refused here and re-created in Postgres.
 *
 * **RECIPIENT-SIDE ONLY, because that is the only column with a foreign key.** `actor` and
 * `metadata` are JSONB and reference nothing, so a notification ABOUT the withdrawn agent held by
 * somebody else survives in Postgres — deleting it here would be the mirror-image divergence.
 *
 * **Synchronous**, like `forgetActivityProjection` and for the same reason: `deleteAgent` performs
 * its whole sweep with no `await` in the middle, and an awaited sweep would yield the event loop
 * halfway through a withdrawal whose maps are live.
 *
 * Here rather than in the caller so the module that owns `notificationDedupKeys` stays its only
 * writer.
 */
export function forgetNotificationsForRecipient(agentId: string): number {
  let deleted = 0;
  for (const [id, row] of Array.from(notifications.entries())) {
    if (row.agent_id !== agentId) continue;
    forgetNotification(id);
    deleted += 1;
  }
  return deleted;
}

export async function listNotifications(
  agentId: string,
  options: { limit?: number; unreadOnly?: boolean } = {}
): Promise<StoredNotification[]> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 25)));
  return Array.from(notifications.values())
    .filter((n) => n.agent_id === agentId)
    .filter((n) => !options.unreadOnly || n.read_at === null)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export async function markNotificationRead(
  agentId: string,
  notificationId: string
): Promise<{ success: boolean; error?: string }> {
  const row = notifications.get(notificationId);
  if (!row || row.agent_id !== agentId) return { success: false, error: "not_found" };
  if (!row.read_at) notifications.set(notificationId, { ...row, read_at: new Date().toISOString() });
  return { success: true };
}

export async function markAllNotificationsRead(agentId: string): Promise<{ markedCount: number }> {
  const now = new Date().toISOString();
  let markedCount = 0;
  for (const [id, row] of Array.from(notifications.entries())) {
    if (row.agent_id === agentId && row.read_at === null) {
      notifications.set(id, { ...row, read_at: now });
      markedCount += 1;
    }
  }
  return { markedCount };
}

export async function countUnreadNotifications(agentId: string): Promise<number> {
  return Array.from(notifications.values()).filter((n) => n.agent_id === agentId && n.read_at === null).length;
}

export function __resetNotificationsForTests(): void {
  notifications.clear();
  notificationDedupKeys.clear();
}
