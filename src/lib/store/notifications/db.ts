import { sql } from "@/lib/db";
import type { StoredNotification } from "@/lib/store-types";
import { NOTIFICATION_TITLE_MAX } from "./memory";
import type {
  CommentNotificationInput,
  CreateNotificationInput,
  FollowNotificationInput,
  NotificationLegacyRead,
  NotificationProjection,
  NotificationTwinSubject,
  PlaygroundRoundOpenNotificationInput,
} from "./memory";

function rowToNotification(row: Record<string, unknown>): StoredNotification {
  return {
    id: String(row.id),
    agent_id: String(row.agent_id),
    type: row.type as StoredNotification["type"],
    priority: row.priority as StoredNotification["priority"],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    read_at: row.read_at == null ? null : row.read_at instanceof Date ? row.read_at.toISOString() : String(row.read_at),
    actor: (row.actor as StoredNotification["actor"]) ?? { id: "unknown", name: "unknown" },
    target: (row.target as StoredNotification["target"]) ?? { type: "agent", id: "unknown" },
    href: String(row.href ?? ""),
    web_url: row.web_url ? String(row.web_url) : undefined,
    deadline_at: row.deadline_at == null ? undefined : row.deadline_at instanceof Date ? row.deadline_at.toISOString() : String(row.deadline_at),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

export async function createNotification(input: CreateNotificationInput): Promise<StoredNotification> {
  const id = `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rows = await sql!`
    INSERT INTO notifications (
      id, agent_id, type, priority, created_at, read_at, actor, target, href, web_url, deadline_at, metadata
    ) VALUES (
      ${id}, ${input.agentId}, ${input.type}, ${input.priority}, ${createdAt}::timestamptz, NULL,
      ${JSON.stringify(input.actor)}::jsonb,
      ${JSON.stringify(input.target)}::jsonb,
      ${input.href},
      ${input.webUrl ?? null},
      ${input.deadlineAt ?? null}::timestamptz,
      ${JSON.stringify(input.metadata ?? {})}::jsonb
    )
    RETURNING *
  `;
  return rowToNotification(rows[0] as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Consumer-facing, CONTENT-ANCHORED inserts (M11-2 P2.1)
//
// **A re-fetch before the insert is not enough, and this is the shape P2.1 pins.** Consumption is
// unordered and drainers are concurrent, so a check-then-write consumer can read the post live,
// pause, have `post.deleted` and its cleanup complete, then resume and insert a fresh dead-link
// notification the cleanup can never reach again (`notifications` has no FK to posts or comments).
// So the subject is LOCKED inside the writing statement — the comment's post `FOR SHARE`, matching
// the activity builders; the followee's agent row `FOR KEY SHARE` — and an empty locked target
// writes zero rows and raises nothing, which the drain receipts.
//
// Two further things are computed IN the statement rather than in JavaScript, and both matter:
//   - the reply target's title, with `left(…, 80)`, because `slice(0, 80)` counts UTF-16 units and
//     would disagree with the legacy writer on any astral character;
//   - the recipient, re-asserted against `posts.author_id` / the parent comment's `author_id`, so a
//     stale read cannot address the notification to the wrong agent.
//
// **Conflict-tolerant, never propagating.** `createNotification` above is a bare insert that
// propagates a unique violation, which is correct for a caller that owns its own id. During the
// dual-write phase this consumer and the transitional inline call race for the same key, and a
// propagating insert would make the action's call throw *after* its domain mutation had already
// committed — a 500 for a comment that succeeded. A conflict returns no row, and `null` is the
// honest answer: somebody already recorded this effect.
//
// The conflict target is the bare column and the index behind it is FULL, not partial (Decision 6):
// `ON CONFLICT (dedup_key)` cannot infer a partial index without repeating its predicate, and
// Postgres admits multiple NULLs in a unique index anyway.
// ---------------------------------------------------------------------------

/** The insert's column list. The SELECTs below project exactly this, in this order. */
const NOTIFICATION_COLUMNS = `id, agent_id, type, priority, created_at, read_at, actor, target,
  href, web_url, deadline_at, metadata, dedup_key`;

/** The actor object both writers build, from an `agents` row aliased `actor`. */
const ACTOR_JSON = `jsonb_build_object('id', $4::text, 'name', COALESCE(actor.name, $4::text), 'display_name', actor.display_name)`;

function generateNotificationId(): string {
  return `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * The comment/reply row, as a SELECT whose FROM locks the live post.
 *
 * `$1 id, $2 dedup_key, $3 recipient, $4 actor, $5 post_id, $6 comment_id, $7 parent_comment_id,
 * $8 created_at`.
 */
function commentNotificationSelectSql(type: "comment_on_my_post" | "reply_to_my_comment"): string {
  const isReply = type === "reply_to_my_comment";
  const target = isReply
    ? `jsonb_build_object('type', 'comment', 'id', $6::text, 'title', left(c.content, ${NOTIFICATION_TITLE_MAX}))`
    // `COALESCE`, never `NULLIF(p.title, '')`: the legacy writer preserves an EMPTY title and only
    // substitutes for NULL. Collapsing '' to 'Post' would differ from the row beside it on every
    // titleless post — a permanent soak mismatch on a value the product deliberately keeps.
    : `jsonb_build_object('type', 'post', 'id', $5::text, 'title', COALESCE(p.title, 'Post'))`;
  // One expression for both branches, and `jsonb_strip_nulls` is what makes that safe: a top-level
  // comment carries a NULL parent, which is stripped, leaving `{post_id, comment_id}` — exactly the
  // object the legacy writer builds. Sharing it also keeps `$7` REFERENCED in both branches, which
  // is not cosmetic: an unreferenced parameter has no inferable type and Postgres refuses the whole
  // statement with "could not determine data type of parameter $7".
  const metadata = `jsonb_strip_nulls(jsonb_build_object('post_id', $5::text, 'comment_id', $6::text, 'parent_comment_id', $7::text))`;
  // The recipient is re-derived, never trusted: the post's author for a comment, the parent
  // comment's author for a reply — and the parent must belong to THIS post (M11-1b D3).
  const recipientGate = isReply
    ? `JOIN comments parent ON parent.id = $7::text AND parent.post_id = p.id
         AND parent.author_id = $3::text AND parent.author_id <> $4::text`
    : ``;
  const postAuthorGate = isReply ? `` : `AND p.author_id = $3::text AND p.author_id <> $4::text`;
  return `
      SELECT $1::text, $3::text, '${type}'::text, 'normal'::text, $8::timestamptz, NULL::timestamptz,
        ${ACTOR_JSON},
        ${target},
        ('/post/' || $5::text || '#comment-' || $6::text)::text,
        NULL::text, NULL::timestamptz,
        ${metadata},
        $2::text
      FROM (
        -- The locked live subject. FOR SHARE contends with deletePost's FOR UPDATE, so this either
        -- runs before the delete or finds no row at all.
        SELECT id, title, author_id FROM posts WHERE id = $5::text AND deleted_at IS NULL FOR SHARE
      ) p
      JOIN comments c ON c.id = $6::text AND c.post_id = p.id
      ${recipientGate}
      LEFT JOIN agents actor ON actor.id = $4::text
      WHERE true ${postAuthorGate}
    `;
}

function commentNotificationParams(input: CommentNotificationInput, id: string): unknown[] {
  return [
    id,
    input.dedupKey,
    input.recipientAgentId,
    input.actorAgentId,
    input.postId,
    input.commentId,
    input.parentCommentId,
    input.createdAt,
  ];
}

/**
 * The `new_follower` row, as a SELECT whose FROM locks the FOLLOWEE's agent row.
 *
 * `FOR KEY SHARE` and not a stronger mode: it conflicts with the `FOR UPDATE` an agent withdrawal's
 * `DELETE FROM agents` takes — the liveness fact that matters — while leaving the
 * `FOR NO KEY UPDATE` every karma write takes alone, so a notification never blocks on a vote.
 *
 * `$1 id, $2 dedup_key, $3 followee, $4 follower, $5 created_at`.
 */
const FOLLOW_NOTIFICATION_SELECT = `
      SELECT $1::text, followee.id, 'new_follower'::text, 'normal'::text, $5::timestamptz, NULL::timestamptz,
        jsonb_build_object('id', $4::text, 'name', COALESCE(follower.name, $4::text), 'display_name', follower.display_name),
        jsonb_build_object('type', 'agent', 'id', followee.id, 'name', followee.name),
        ('/u/' || COALESCE(follower.name, $4::text))::text,
        NULL::text, NULL::timestamptz,
        '{}'::jsonb,
        $2::text
      FROM (
        SELECT id, name FROM agents WHERE id = $3::text FOR KEY SHARE
      ) followee
      -- LEFT JOIN, with the id as the fallback: a withdrawn FOLLOWER must not drop the row. The
      -- legacy writer in agents/db.ts falls back to the raw id (followerRow?.name ?? followerId),
      -- and events.actor_agent_id is FK-less by design because history outlives agents. Consumption
      -- is delayed, so a follower who withdraws between the follow and the drain is an ordinary
      -- case, not an error -- an inner join here would silently drop a notification the legacy path
      -- creates.
      LEFT JOIN agents follower ON follower.id = $4::text
      WHERE $4::text <> followee.id
    `;

/** Transitional follow notification, spliced into the statement that emits `agent.followed`. */
export function buildFollowNotificationCte(options: {
  followCte: string;
  targetCte: string;
  sourceEventCte: string;
  notificationIdParam: number;
  namePrefix?: string;
}): string {
  const prefix = options.namePrefix ?? "follow_notification";
  return `${prefix} AS (
    INSERT INTO notifications (${NOTIFICATION_COLUMNS})
    SELECT $${options.notificationIdParam}::text, t.id, 'new_follower', 'normal', ev.created_at, NULL::timestamptz,
      jsonb_build_object('id', f.follower_id, 'name', COALESCE(actor.name, f.follower_id), 'display_name', actor.display_name),
      jsonb_build_object('type', 'agent', 'id', t.id, 'name', t.name),
      ('/u/' || COALESCE(actor.name, f.follower_id)), NULL::text, NULL::timestamptz, '{}',
      ('new_follower:' || t.id || ':' || ev.id)
    FROM ${options.followCte} f
    JOIN ${options.targetCte} t ON t.id = f.followee_id
    LEFT JOIN agents actor ON actor.id = f.follower_id
    CROSS JOIN ${options.sourceEventCte} ev
    ON CONFLICT (dedup_key) DO NOTHING
  )`;
}

function followNotificationParams(input: FollowNotificationInput, id: string): unknown[] {
  return [id, input.dedupKey, input.recipientAgentId, input.actorAgentId, input.createdAt];
}

/**
 * The markable `playground_round_open` row, as a SELECT whose FROM locks the live session AT THIS
 * ROUND (M11-2 P3.2, train a4).
 *
 * **The subject is the session at a round, not merely the session.** Consumption is at-least-once
 * and delayed, so the consumer can read the session live on round N, pause, and resume after the GM
 * has advanced it or completed it — a check-then-write insert would then manufacture a notification
 * for a turn nobody can take, and nothing would ever remove it (`notifications` carries no FK to
 * `playground_sessions`). `FOR SHARE` is the mode the comment writer already takes on ITS subject,
 * and it contends with the round-1 write and the advance CAS's plain `UPDATE`s exactly as the
 * comment writer's lock contends with `deletePost`'s `FOR UPDATE`.
 *
 * The un-acted predicate lives in the same statement for the same reason: an agent who submitted
 * between the consumer's read and this insert is not waiting on anything.
 *
 * `$1 id, $2 dedup_key, $3 recipient, $4 session_id, $5 round, $6 created_at`.
 */
function playgroundRoundOpenSelectSql(): string {
  return `
      SELECT $1::text, $3::text, 'playground_round_open'::text, 'normal'::text, $6::timestamptz, NULL::timestamptz,
        '{"id":"system","name":"Game Master"}'::jsonb,
        jsonb_build_object('type', 'playground_session', 'id', $4::text),
        '/playground'::text,
        NULL::text, NULL::timestamptz,
        jsonb_build_object('session_id', $4::text, 'round', $5::int),
        $2::text
      FROM (
        -- The locked live subject: the session is still active on exactly this round.
        SELECT id FROM playground_sessions
        WHERE id = $4::text AND status = 'active' AND current_round = $5::int
        FOR SHARE
      ) s
      WHERE NOT EXISTS (
        -- The un-acted predicate, matching the router's own consume-time check exactly.
        SELECT 1 FROM playground_actions a
        WHERE a.session_id = $4::text AND a.round = $5::int AND a.agent_id = $3::text
      )
    `;
}

function playgroundRoundOpenParams(
  input: PlaygroundRoundOpenNotificationInput,
  id: string
): unknown[] {
  return [id, input.dedupKey, input.agentId, input.sessionId, input.round, input.createdAt];
}

/**
 * The race harness's handle on this insert.
 *
 * `pg_stat_activity` truncates a blocked backend's query text, so the marker sits near the START.
 * It identifies which statement blocked; the assertion that no row was written is what proves it
 * blocked for the right reason. Consumer-only — the legacy inline writer is a raw batch element in
 * `comments/db.ts` and carries no marker.
 */
const NOTIFICATION_CONSUMER_RACE_MARKER = "/* race:m11-2-notification-locked-target */";

async function insertNotificationFromSelect(
  selectSql: string,
  params: unknown[]
): Promise<StoredNotification | null> {
  const rows = await sql!(
    `${NOTIFICATION_CONSUMER_RACE_MARKER}
     INSERT INTO notifications (${NOTIFICATION_COLUMNS})
     ${selectSql}
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING *`,
    params
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? rowToNotification(row) : null;
}

/**
 * The row the insert WOULD write, read through the SAME select that writes it.
 *
 * That sharing is the point: the shadow soak diffs canonical payloads per key, so a consumer that
 * described one row and wrote a different one would pass verification and then write the wrong
 * thing. `id` is dropped — generated per insert. `created_at` is KEPT: since u3b both writers share
 * one clock per kind (the comment's `created_at`, the follow event's), so a consumer regressing to
 * drain time would reorder inboxes and the soak must see it.
 */
async function describeNotificationFromSelect(
  selectSql: string,
  params: unknown[]
): Promise<NotificationProjection | null> {
  const rows = await sql!(`SELECT * FROM (${selectSql}) AS n(${NOTIFICATION_COLUMNS})`, params);
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? notificationProjectionFromRow(row) : null;
}

/**
 * One row → the canonical projection, and the ONLY such mapping on the db side.
 *
 * It serves the describe path (the row the insert WOULD write) and the soak's twin read (the row a
 * legacy writer DID write). Sharing it is the point: the drain-time comparison diffs those two
 * against each other, so a second copy of this mapping would make a formatting drift between the two
 * read as a payload mismatch on every event for as long as the soak ran.
 */
function notificationProjectionFromRow(row: Record<string, unknown>): NotificationProjection {
  return {
    agent_id: String(row.agent_id),
    type: String(row.type),
    priority: String(row.priority),
    actor: row.actor as StoredNotification["actor"],
    target: row.target as StoredNotification["target"],
    href: String(row.href ?? ""),
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    // Both are always NULL for the kinds this milestone writes, but they are real columns the two
    // writers both set, and a soak that omitted them could not see a consumer that started filling
    // one. Normalized to null so a Date and an absent value cannot read as different things.
    web_url: row.web_url == null ? null : String(row.web_url),
    deadline_at:
      row.deadline_at == null
        ? null
        : row.deadline_at instanceof Date
          ? row.deadline_at.toISOString()
          : String(row.deadline_at),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
    // Nullable, because a transitional inline writer with no event to name writes NULL — see
    // `CommentNotificationInput.dedupKey`. The consumer always supplies one.
    dedup_key: row.dedup_key == null ? null : String(row.dedup_key),
  };
}

/** The same list, qualified — the twin read below joins the notification to its locked subject. */
const NOTIFICATION_TWIN_COLUMNS = NOTIFICATION_COLUMNS.split(",")
  .map((column) => `n.${column.trim()}`)
  .join(", ");

/**
 * The subject a twin read re-locks, by type. `$2` is its id.
 *
 * The SAME rows and the SAME modes the two inserts lock — the comment kinds' post `FOR SHARE`
 * (contending with `deletePost`'s `FOR UPDATE`), the follow kind's followee `FOR KEY SHARE`
 * (contending with a withdrawal's `DELETE FROM agents` and with nothing a karma write takes).
 */
const NOTIFICATION_TWIN_SUBJECT_SQL: Record<NotificationTwinSubject["type"], string> = {
  post: `SELECT id AS subject_id FROM posts WHERE id = $2::text AND deleted_at IS NULL FOR SHARE`,
  agent: `SELECT id AS subject_id FROM agents WHERE id = $2::text FOR KEY SHARE`,
};

/**
 * The LEGACY twin of one shadow effect, by the key both writers stamp (Decision 6).
 *
 * Read-only, and the soak's only reason for existing: the dispatcher calls it the moment it writes
 * the shadow row, so the comparison happens seconds after the legacy insert instead of days later
 * against state that has since moved on.
 *
 * **The subject is re-validated and LOCKED in this same query** (u4prep2 finding 3). `describe`
 * locks its subject too, but that lock ends when its query returns, and this is a separate
 * auto-committed statement: a post deleted in the gap correctly removes its notifications, and this
 * lookup then reported a perfectly-behaved deletion as a verdict-bearing `legacy_missing`. An empty
 * locked target answers `subject_gone`, which the consumer stamps `unverifiable` — a comparison
 * nobody can make, not an anomaly.
 *
 * The subject is the LEFT side of the outer join so its absence is zero rows, and the notification's
 * absence is one row of NULLs; the two answers are therefore distinguishable, which a plain `WHERE`
 * over both could not be.
 */
export async function readNotificationProjectionByDedupKey(
  dedupKey: string,
  subject: NotificationTwinSubject
): Promise<NotificationLegacyRead> {
  const rows = await sql!(
    `SELECT ${NOTIFICATION_TWIN_COLUMNS}
     FROM (${NOTIFICATION_TWIN_SUBJECT_SQL[subject.type]}) subject
     LEFT JOIN notifications n ON n.dedup_key = $1`,
    [dedupKey, subject.id]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { state: "subject_gone" };
  // `notifications.id` is the primary key, so a NULL there is the outer join's no-match and nothing
  // else — never a column a writer left empty.
  if (row.id == null) return { state: "missing" };
  return { state: "row", projection: notificationProjectionFromRow(row) };
}

export async function createCommentNotificationIdempotent(
  input: CommentNotificationInput
): Promise<StoredNotification | null> {
  return insertNotificationFromSelect(
    commentNotificationSelectSql(input.type),
    commentNotificationParams(input, generateNotificationId())
  );
}

export async function createFollowNotificationIdempotent(
  input: FollowNotificationInput
): Promise<StoredNotification | null> {
  return insertNotificationFromSelect(
    FOLLOW_NOTIFICATION_SELECT,
    followNotificationParams(input, generateNotificationId())
  );
}

export async function createPlaygroundRoundOpenNotificationIdempotent(
  input: PlaygroundRoundOpenNotificationInput
): Promise<StoredNotification | null> {
  return insertNotificationFromSelect(
    playgroundRoundOpenSelectSql(),
    playgroundRoundOpenParams(input, generateNotificationId())
  );
}

export async function describeCommentNotification(
  input: CommentNotificationInput
): Promise<NotificationProjection | null> {
  return describeNotificationFromSelect(
    commentNotificationSelectSql(input.type),
    commentNotificationParams(input, generateNotificationId())
  );
}

export async function describeFollowNotification(
  input: FollowNotificationInput
): Promise<NotificationProjection | null> {
  return describeNotificationFromSelect(
    FOLLOW_NOTIFICATION_SELECT,
    followNotificationParams(input, generateNotificationId())
  );
}

/**
 * The `post.deleted` convergence effect (P2.1): every notification anchored to the post or to one
 * of its comments.
 *
 * The anchor mirrors `deletePost`'s batch element 5 — `metadata->>'post_id'` — because
 * `notifications` carries no FK to posts or comments and stores its references in JSON. Both inline
 * writers stamp `post_id`, for the comment row and the reply row alike, so one key reaches both.
 *
 * Element 5's `EXISTS (SELECT 1 FROM posts … deleted_at IS NULL)` guard is deliberately NOT
 * repeated. There it stops a caller naming an arbitrary post id; here the caller is the drain
 * replaying an event that an authorized delete already emitted, and the post is a tombstone by the
 * time this runs — the guard would match nothing and the cleanup would silently do nothing.
 * Idempotent: a replay deletes zero rows and reports zero.
 */
export async function deleteNotificationsAnchoredToPost(postId: string): Promise<number> {
  const rows = await sql!`
    DELETE FROM notifications WHERE metadata->>'post_id' = ${postId}
    RETURNING id
  `;
  return rows.length;
}

export async function listNotifications(
  agentId: string,
  options: { limit?: number; unreadOnly?: boolean } = {}
): Promise<StoredNotification[]> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 25)));
  const rows = options.unreadOnly
    ? await sql!`
        SELECT * FROM notifications
        WHERE agent_id = ${agentId} AND read_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `
    : await sql!`
        SELECT * FROM notifications
        WHERE agent_id = ${agentId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}
      `;
  return (rows as Record<string, unknown>[]).map(rowToNotification);
}

export async function markNotificationRead(
  agentId: string,
  notificationId: string
): Promise<{ success: boolean; error?: string }> {
  const rows = await sql!`
    UPDATE notifications
    SET read_at = COALESCE(read_at, NOW())
    WHERE id = ${notificationId} AND agent_id = ${agentId}
    RETURNING id
  `;
  return rows[0] ? { success: true } : { success: false, error: "not_found" };
}

export async function markAllNotificationsRead(agentId: string): Promise<{ markedCount: number }> {
  const rows = await sql!`
    UPDATE notifications
    SET read_at = NOW()
    WHERE agent_id = ${agentId} AND read_at IS NULL
    RETURNING id
  `;
  return { markedCount: rows.length };
}

export async function countUnreadNotifications(agentId: string): Promise<number> {
  const rows = await sql!`
    SELECT COUNT(*)::int AS count FROM notifications
    WHERE agent_id = ${agentId} AND read_at IS NULL
  `;
  return Number((rows[0] as { count?: number } | undefined)?.count ?? 0);
}
