import { hasDatabase, sql } from "@/lib/db";
import type { StoredActivityFeedItem, StoredActivityFeedKind, StoredActivityFeedOptions } from "@/lib/store-types";
import {
  activityEventKey,
  activityContexts,
  activityEvents,
  activityEventSourceIds,
  activityFeedMatches,
  activityFeedIncludes,
  agents,
  comments,
  forgetActivityProjection,
  groups,
  memoryAgentNames,
  normalizeActivityTypeSet,
  playgroundActions,
  playgroundSessions,
  posts,
} from "../_memory-state";

export interface ActivityEventInput {
  kind: StoredActivityFeedKind;
  occurredAt: string;
  actorId?: string;
  actorName?: string;
  actorCanonicalName?: string;
  entityId: string;
  title: string;
  href?: string;
  summary: string;
  contextHint?: string;
  searchText?: string;
  metadata?: Record<string, unknown>;
}

const ACTIVITY_EVENT_KINDS: StoredActivityFeedKind[] = [
  "post",
  "comment",
  "evaluation_result",
  "playground_session",
  "playground_action",
  "agent_loop",
  "follow",
  "group_join",
  "ao_company",
  "ao_fellowship",
  "ao_demo_day",
  "ao_working_paper",
  "school_event",
];

function activityKindsFromTypes(types?: string[]): StoredActivityFeedKind[] {
  const normalized = normalizeActivityTypeSet(types);
  return normalized.size === 0
    ? ACTIVITY_EVENT_KINDS
    : ACTIVITY_EVENT_KINDS.filter((kind) => activityFeedIncludes(kind, normalized));
}

function rowToActivityEvent(row: Record<string, unknown>): StoredActivityFeedItem {
  return {
    id: String(row.entity_id),
    cursorId: row.cursor_id ? String(row.cursor_id) : undefined,
    kind: row.kind as StoredActivityFeedKind,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    actorName: row.actor_name ? String(row.actor_name) : undefined,
    actorCanonicalName: row.actor_canonical_name ? String(row.actor_canonical_name) : undefined,
    title: String(row.title),
    href: row.href ? String(row.href) : undefined,
    summary: String(row.summary),
    contextHint: String(row.context_hint ?? ""),
    searchText: String(row.search_text ?? ""),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

function inputToStoredEvent(input: ActivityEventInput): StoredActivityFeedItem {
  // Memory cursors use the same uniqueness tuple as the map key; DB cursors use activity_events.id UUIDs.
  return {
    id: input.entityId,
    cursorId: activityEventKey(input.kind, input.entityId),
    kind: input.kind,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    actorName: input.actorName,
    actorCanonicalName: input.actorCanonicalName,
    title: input.title,
    href: input.href,
    summary: input.summary,
    contextHint: input.contextHint ?? "",
    searchText: input.searchText ?? "",
    metadata: input.metadata ?? {},
  };
}

async function deleteCachedActivityContextsForEvent(kind: StoredActivityFeedKind, entityId: string): Promise<void> {
  // Activity context rows summarize the current projection row, so any event
  // rewrite must force the next expansion to regenerate every prompt version.
  if (hasDatabase()) {
    await sql!`
      DELETE FROM activity_contexts
      WHERE activity_kind = ${kind}
        AND activity_id = ${entityId}
    `;
    return;
  }

  deleteCachedActivityContextsInMemory(kind, entityId);
}

/**
 * The memory half of the invalidation, **synchronously** — the form an atomic section can call.
 *
 * Memory mode has no transaction, so the only thing standing in for the db statement's all-or-nothing
 * is "no `await` between the mutation, its event append and its projection" (Decision 4). The async
 * wrapper above cannot be used inside such a section without opening exactly the window it exists to
 * close, and the work itself is a `Map` scan that never needed to be async in the first place.
 */
function deleteCachedActivityContextsInMemory(kind: StoredActivityFeedKind, entityId: string): void {
  const prefix = `${kind}:${entityId}:`;
  for (const key of Array.from(activityContexts.keys())) {
    if (key.startsWith(prefix)) activityContexts.delete(key);
  }
}

// ---------------------------------------------------------------------------
// One upsert, many writers (M9/C9)
//
// Every activity-event writer shares the same 12-column INSERT and idempotent
// ON CONFLICT update; only the enrichment SELECT differs per source table.
// The SELECT stays SQL so each writer keeps joining its source tables (posts,
// agents, groups, playground_*, agent_loop_action_log) for write-time
// enrichment — that contract is pinned by event-writers-db.test.ts.
// ---------------------------------------------------------------------------

const ACTIVITY_EVENT_COLUMNS = `kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id,
        title, href, summary, context_hint, search_text, metadata`;

const ACTIVITY_EVENT_ON_CONFLICT = `ON CONFLICT (kind, entity_id) DO UPDATE SET
        occurred_at = EXCLUDED.occurred_at,
        actor_id = EXCLUDED.actor_id,
        actor_name = EXCLUDED.actor_name,
        actor_canonical_name = EXCLUDED.actor_canonical_name,
        title = EXCLUDED.title,
        href = EXCLUDED.href,
        summary = EXCLUDED.summary,
        context_hint = EXCLUDED.context_hint,
        search_text = EXCLUDED.search_text,
        metadata = EXCLUDED.metadata`;

/**
 * The same 12-column list, plus `source_event_id` when the writer is an event consumer.
 *
 * The column is nullable and the legacy writers leave it NULL; only the consumer path stamps it.
 */
function activityEventColumns(withSourceEvent: boolean): string {
  return withSourceEvent ? `${ACTIVITY_EVENT_COLUMNS}, source_event_id` : ACTIVITY_EVENT_COLUMNS;
}

/**
 * The conflict clause, plus the **monotonic source-event guard** for consumer writes (M11-2 P2.1).
 *
 * Consumption is explicitly unordered and drainers are concurrent (P2.2), and this upsert replaces
 * every field on conflict — so a late-consumed OLDER event for a reused natural key would overwrite
 * the newer projection and move the public trail backward. The follow row is the canonical case: one
 * `follower:followee` key is reused across every re-follow.
 *
 * `COALESCE(…, 0)` is what makes legacy rows yield: a row written by an inline writer carries NULL,
 * and event ids start at 1, so any event may claim it. `<=` rather than `<` so re-consuming the
 * SAME event still converges the row (at-least-once delivery means that happens routinely).
 */
function activityEventOnConflict(sourceEventParam: string | null): string {
  if (!sourceEventParam) return ACTIVITY_EVENT_ON_CONFLICT;
  return `${ACTIVITY_EVENT_ON_CONFLICT},
        source_event_id = EXCLUDED.source_event_id
      WHERE COALESCE(activity_events.source_event_id, 0) <= EXCLUDED.source_event_id`;
}

/** Actor display name for an `agents` row aliased `a`, with a raw-id fallback expression. */
function actorDisplaySql(idExpr: string): string {
  return `COALESCE(NULLIF(a.display_name, ''), a.name, ${idExpr})`;
}

/** Actor canonical name for an `agents` row aliased `a`, with a raw-id fallback expression. */
function actorCanonicalSql(idExpr: string): string {
  return `COALESCE(a.name, ${idExpr})`;
}

/**
 * Run one idempotent activity-event upsert whose row is produced by
 * `selectSql` (a SELECT projecting exactly the shared column list), then
 * invalidate the event's cached contexts.
 */
async function upsertActivityEventFromSelect(
  kind: StoredActivityFeedKind,
  entityId: string,
  selectSql: string,
  params: unknown[],
  sourceEventParam: string | null = null
): Promise<void> {
  const rows = await sql!(
    `
      INSERT INTO activity_events (
        ${activityEventColumns(sourceEventParam !== null)}
      )
      ${selectSql}
      ${activityEventOnConflict(sourceEventParam)}
      RETURNING entity_id
    `,
    params
  );
  // **Only when the upsert actually wrote.** Two ways it writes nothing, and the cache must survive
  // both: the locked target was empty (the subject is gone, and `deletePost` already removed its
  // contexts), or the monotonic guard REFUSED a stale older event — in which case the row on disk
  // belongs to a newer event, and blowing away its cached contexts would make a late arrival
  // silently discard work that is still current.
  if (rows.length > 0) await deleteCachedActivityContextsForEvent(kind, entityId);
}

async function recordActivityEventInDatabase(input: ActivityEventInput): Promise<void> {
  // `post` and `comment` have DEDICATED writers, and the reason is the liveness lock: this generic
  // path takes pre-built fields and cannot prove the post is still live, so writing one of those
  // kinds through it would recreate exactly the dead link `deletePost` removes (M11-1b D1). Refuse
  // loudly rather than write an ungated projection. Today's only external caller allowlists
  // school/AO kinds, so this guards a future one.
  if (input.kind === "post" || input.kind === "comment") {
    throw new Error(
      `recordActivityEvent cannot write '${input.kind}' events: use recordPostActivityEvent or buildCommentActivityUpsert, which gate on a live post`
    );
  }
  await upsertActivityEventFromSelect(
    input.kind,
    input.entityId,
    `
      SELECT
        $1::text, $2::timestamptz, $3::text, $4::text, $5::text, $6::text,
        $7::text, $8::text, $9::text, $10::text, $11::text, $12::jsonb
    `,
    [
      input.kind,
      input.occurredAt,
      input.actorId ?? null,
      input.actorName ?? null,
      input.actorCanonicalName ?? null,
      input.entityId,
      input.title,
      input.href ?? null,
      input.summary,
      input.contextHint ?? "",
      input.searchText ?? "",
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

function recordActivityEventInMemory(input: ActivityEventInput): void {
  activityEvents.set(activityEventKey(input.kind, input.entityId), inputToStoredEvent(input));
}

/** Best-effort projection write: entity writes remain authoritative if this fails. */
export async function recordActivityEvent(input: ActivityEventInput): Promise<void> {
  try {
    if (hasDatabase()) {
      await recordActivityEventInDatabase(input);
      return;
    }
    recordActivityEventInMemory(input);
    await deleteCachedActivityContextsForEvent(input.kind, input.entityId);
  } catch (error) {
    console.error("[activity-events] failed to record activity event", error, "input:", input);
  }
}

function logActivityEventFailure(label: string, error: unknown): void {
  console.error(`[activity-events] failed to record ${label} activity event`, error);
}

export interface PostActivityInput {
  id: string;
  authorId: string;
  groupId: string;
  title: string;
  content?: string;
  url?: string;
  createdAt: string;
}

/**
 * The post activity SELECT, shared by the legacy inline writer and the event consumer.
 *
 * One definition, two callers, because the shadow soak compares what the consumer would write
 * against what the inline writer did write — two copies of this projection would make a mismatch a
 * property of the SQL rather than of the cutover.
 */
function postActivitySelectSql(sourceEventParam: string | null): string {
  return `
      SELECT
        'post',
        v.created_at,
        v.author_id,
        ${actorDisplaySql("v.author_id")}::text,
        ${actorCanonicalSql("v.author_id")}::text,
        v.id,
        v.title,
        ('/post/' || v.id)::text,
        ('Post in ' || COALESCE('g/' || g.name, 'a group') || ': ' || v.title)::text,
        COALESCE(v.content, v.url, v.title, '')::text,
        concat_ws(' ', ${actorDisplaySql("v.author_id")}, a.name, 'post', v.title, v.content, v.url, g.name)::text,
        jsonb_build_object('post_id', v.id, 'group', g.name, 'group_id', v.group_id, 'upvotes', 0, 'comments', 0)${
          sourceEventParam ? `,\n        ${sourceEventParam}::bigint` : ""
        }
      FROM (
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::timestamptz)
      ) AS v(id, title, content, url, author_id, group_id, created_at)
      -- The post must still be LIVE, and the check is a lock (M11-1b D1; P2.1's locked-target rule
      -- for consumers). createPost commits the row and writes this projection in a second
      -- statement, so an author who deletes in that window leaves deletePost with no event to
      -- remove -- and this upsert would then publish a deleted post's title and a dead /post/ link
      -- onto the trail, permanently. A check-THEN-write re-fetch is not enough for the consumer
      -- either: consumption is unordered and drainers are concurrent, so it could read the post
      -- live, pause, have post.deleted and its cleanup complete, then resume and insert. FOR SHARE
      -- contends with the delete's FOR UPDATE, so this either runs before it or finds no row --
      -- and an empty target writes nothing and raises nothing, which the drain receipts.
      JOIN (
        SELECT id FROM posts WHERE id = $1 AND deleted_at IS NULL FOR SHARE
      ) live ON live.id = v.id
      LEFT JOIN agents a ON a.id = v.author_id
      LEFT JOIN groups g ON g.id = v.group_id
    `;
}

function postActivityParams(input: PostActivityInput): unknown[] {
  return [
    input.id,
    input.title,
    input.content ?? null,
    input.url ?? null,
    input.authorId,
    input.groupId,
    input.createdAt,
  ];
}

/**
 * The memory-mode post projection, or null when the post is not live.
 *
 * Extracted so the legacy writer and the consumer share one field derivation, exactly as the two db
 * callers share `postActivitySelectSql`.
 */
function buildMemoryPostActivityInput(input: PostActivityInput): ActivityEventInput | null {
  // Memory parity with the db gate: a post deleted between its insert and this projection must not
  // get an activity row, or the trail keeps a dead link the delete already cleaned.
  const livePost = posts.get(input.id);
  if (!livePost || livePost.deletedAt) return null;

  const names = memoryAgentNames(input.authorId);
  const group = groups.get(input.groupId);
  return {
    kind: "post",
    occurredAt: input.createdAt,
    actorId: input.authorId,
    actorName: names.display,
    actorCanonicalName: names.canonical,
    entityId: input.id,
    title: input.title,
    href: `/post/${input.id}`,
    summary: `Post in ${group ? `g/${group.name}` : "a group"}: ${input.title}`,
    contextHint: input.content || input.url || input.title,
    searchText: [names.display, names.canonical, "post", input.title, input.content, input.url, group?.name].filter(Boolean).join(" "),
    metadata: { post_id: input.id, group: group?.name, group_id: input.groupId, upvotes: 0, comments: 0 },
  };
}

/**
 * The inline post-activity writer — now **transitionally stamped** (M11-2 P1.1).
 *
 * `sourceEventId` is the id of the `post.created` event the same statement emitted, and passing it
 * is what makes the dual-write phase correlate. The consumer that will replace this writer stamps
 * `source_event_id` and refuses to overwrite a row whose recorded event is newer; a legacy row left
 * at NULL yields to any event at all, so during the phase where both writers run the ordering
 * between them would be decided by whichever landed last rather than by which event is newer.
 *
 * `occurred_at` needs no transitional stamp for this kind, and that is a fact about the projection
 * rather than an omission: both writers project the POST's `created_at` (`postActivitySelectSql`
 * feeds it as `v.created_at`, and the consumer re-fetches the post and passes the same field), so
 * the two sides already share one clock. `agent.followed` is the kind that does not — a follow
 * carries no timestamp anywhere but its event — and its stamp is P1.2's.
 *
 * Callers with no event to correlate (fixtures, reconciliation, the seeds) omit the option and get
 * exactly the pre-M11-2 write.
 */
export async function recordPostActivityEvent(
  input: PostActivityInput,
  options: { sourceEventId?: number } = {}
): Promise<void> {
  try {
    const sourceEventParam = options.sourceEventId === undefined ? null : "$8";
    if (hasDatabase()) {
      await upsertActivityEventFromSelect(
        "post",
        input.id,
        postActivitySelectSql(sourceEventParam),
        sourceEventParam === null
          ? postActivityParams(input)
          : [...postActivityParams(input), options.sourceEventId],
        sourceEventParam
      );
      return;
    }

    const built = buildMemoryPostActivityInput(input);
    if (!built) return;
    if (options.sourceEventId === undefined) {
      await recordActivityEvent(built);
      return;
    }
    // The memory twin of the same stamp — `activityEventSourceIds` is what the memory-mode
    // monotonic guard reads, so a memory-mode legacy write that skipped it would leave Jest's
    // ordering rules different from Postgres's, which is the divergence the memory store exists to
    // prevent.
    if (memoryUpsertActivityProjection(built, options.sourceEventId)) {
      await deleteCachedActivityContextsForEvent("post", input.id);
    }
  } catch (error) {
    logActivityEventFailure("post", error);
  }
}

export interface CommentActivityInput {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  createdAt: string;
  parentId?: string;
}

/**
 * The comment activity upsert as a **prepared query** the caller can carry as an element of its
 * own `sql.transaction` batch (M11-1b D3, review round 2 B3).
 *
 * `createComment` must write the activity row inside the same transaction that holds the post
 * lock: a post-commit upsert can land after a concurrent delete released the lock, creating a
 * dead `/post/...` event. The join additionally filters `deleted_at IS NULL` **and takes
 * `FOR SHARE OF p`** — the filter alone is snapshot-only, so the STANDALONE caller (which holds no
 * post lock) could read the post live, wait on the event-row conflict, and project a post that was
 * tombstoned in between. Inside `createComment`'s batch the lock is already held, so it costs
 * nothing there.
 *
 * Cache invalidation stays the caller's post-commit follow-up — invalidating a cache for a
 * transaction that rolled back would be wrong, and `invalidateCommentActivityCache` exists for
 * exactly that call.
 */
/**
 * A CTE name interpolated into a projection SELECT, checked rather than trusted.
 *
 * `createComment` splices this upsert into its own `WITH` list and names two of that list's CTEs —
 * the comment insert and the event arm. Both are in-repo literals today; "in-repo today" is not a
 * property this module can check later, so the shape is enforced at the splice, exactly as
 * `events/statement.ts` enforces its own CTE names.
 */
const ACTIVITY_CTE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireActivityCteName(name: string): string {
  if (!ACTIVITY_CTE_NAME.test(name)) {
    throw new Error(`[activity] '${name}' is not a usable CTE name`);
  }
  return name;
}

/** What a comment-activity projection may substitute, however it is being run. */
interface CommentActivitySqlOptions {
  /** Join the committed `comments` row — the standalone/consumer form. */
  requireCommitted?: boolean;
  /** Stamp the source event from a bound parameter — the consumer's form. */
  sourceEventId?: number;
  /**
   * M11-2 P1.2 — riding `createComment`'s own statement.
   *
   * `committedCte` is the CTE holding the freshly inserted comment: inside that statement the
   * `comments` TABLE cannot serve as the committed gate, because a CTE reads the statement's
   * snapshot and would not see the row the same statement is inserting. `sourceEventCte` is the
   * event arm, whose id this projection stamps — the value is only available atomically there.
   */
  committedCte?: string;
  sourceEventCte?: string;
}

/** The SQL expression this projection stamps into `source_event_id`, or null when it stamps none. */
function commentActivitySourceEventSql(options: CommentActivitySqlOptions): string | null {
  if (options.sourceEventCte !== undefined) {
    return `(SELECT id FROM ${requireActivityCteName(options.sourceEventCte)})`;
  }
  return options.sourceEventId === undefined ? null : "$7";
}

/**
 * The comment activity upsert as a **CTE body** for `createComment`'s own statement (M11-2 P1.2).
 *
 * It takes no parameters of its own: the caller's `$1..$6` already are `(id, post_id, author_id,
 * content, created_at, parent_id)`, in that order, which is the whole reason `createComment`'s
 * parameter list opens with them. Sharing one SELECT with the consumer and the soak is what keeps
 * the two writers producing the same row; forking a second copy here would be a second definition
 * of the projection.
 *
 * `occurred_at` is deliberately still the COMMENT's `created_at` (`v.created_at`) and not the
 * event's: the consumer re-fetches the comment and projects the same field, so stamping the event's
 * clock here would *introduce* the ordering-key mismatch `OCCURRED_AT_STAMP_PENDING_KINDS` exists to
 * prevent — the same reasoning that cleared `post.created` in u3, and the reason `agent.followed` is
 * the one kind that genuinely needs a clock stamp.
 */
export function buildCommentActivityUpsertCte(options: {
  committedCte: string;
  sourceEventCte: string | null;
}): string {
  const sqlOptions: CommentActivitySqlOptions = {
    committedCte: options.committedCte,
    ...(options.sourceEventCte === null ? {} : { sourceEventCte: options.sourceEventCte }),
  };
  const sourceEventSql = commentActivitySourceEventSql(sqlOptions);
  return `
      INSERT INTO activity_events (
        ${activityEventColumns(sourceEventSql !== null)}
      )
      ${commentActivitySelectSql(sqlOptions)}
      ${activityEventOnConflict(sourceEventSql)}
      RETURNING entity_id
    `;
}

export function buildCommentActivityUpsert(
  input: CommentActivityInput,
  options: { requireCommitted?: boolean; sourceEventId?: number } = {}
): { text: string; params: unknown[] } {
  // Batch elements always execute, so a caller carrying this inside a transaction whose comment
  // insert may write nothing must gate it on the comment row existing. `requireCommitted` adds
  // that join; the standalone caller (which only runs after a successful insert) omits it.
  //
  // The EVENT CONSUMER passes both: it must prove the comment row still exists (its subject can be
  // gone by consume time) and it stamps `source_event_id` so a late older event cannot drag the
  // projection backward. `$7` is free because the params below occupy $1..$6.
  const sourceEventParam = options.sourceEventId === undefined ? null : "$7";
  return {
    text: `
      INSERT INTO activity_events (
        ${activityEventColumns(sourceEventParam !== null)}
      )
      ${commentActivitySelectSql(options)}
      ${activityEventOnConflict(sourceEventParam)}
      RETURNING entity_id
    `,
    params: commentActivityParams(input, options.sourceEventId),
  };
}

/**
 * The comment activity SELECT on its own — one definition, three callers: the upsert above, the
 * consumer's upsert, and the shadow soak's `describe`, which runs it as a plain query.
 */
function commentActivitySelectSql(options: CommentActivitySqlOptions): string {
  // The committed gate names the CTE when this rides `createComment`'s statement, and the table
  // otherwise. Inside that statement the table form matches nothing — a CTE reads the statement's
  // snapshot, which predates the comment being inserted beside it.
  const committedGate = options.committedCte
    ? `JOIN ${requireActivityCteName(options.committedCte)} c ON c.id = v.id`
    : options.requireCommitted
      ? "JOIN comments c ON c.id = v.id"
      : "";
  const sourceEventParam = commentActivitySourceEventSql(options);
  return `
      SELECT
        'comment',
        v.created_at,
        v.author_id,
        ${actorDisplaySql("v.author_id")}::text,
        ${actorCanonicalSql("v.author_id")}::text,
        v.id,
        ('Comment on ' || p.title)::text,
        ('/post/' || p.id)::text,
        ((CASE WHEN v.parent_id IS NULL THEN 'Comment: ' ELSE 'Reply: ' END) || left(regexp_replace(v.content, '\\s+', ' ', 'g'), 180))::text,
        v.content,
        concat_ws(' ', ${actorDisplaySql("v.author_id")}, a.name, 'comment', CASE WHEN v.parent_id IS NULL THEN NULL ELSE 'reply' END, 'post', p.title, v.content)::text,
        jsonb_strip_nulls(jsonb_build_object('comment_id', v.id, 'post_id', p.id, 'post_title', p.title, 'parent_comment_id', v.parent_id, 'upvotes', 0))${
          sourceEventParam ? `,\n        ${sourceEventParam}::bigint` : ""
        }
      FROM (
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::timestamptz, $6::text)
      ) AS v(id, post_id, author_id, content, created_at, parent_id)
      JOIN posts p ON p.id = v.post_id AND p.deleted_at IS NULL
      ${committedGate}
      LEFT JOIN agents a ON a.id = v.author_id
      FOR SHARE OF p
    `;
}

function commentActivityParams(input: CommentActivityInput, sourceEventId?: number): unknown[] {
  return [
    input.id,
    input.postId,
    input.authorId,
    input.content,
    input.createdAt,
    input.parentId ?? null,
    ...(sourceEventId === undefined ? [] : [sourceEventId]),
  ];
}

/** The cache half of a comment activity write, for callers that carried the upsert themselves. */
export async function invalidateCommentActivityCache(commentId: string): Promise<void> {
  await deleteCachedActivityContextsForEvent("comment", commentId);
}

/** The memory-mode comment projection, or null when the parent post is gone (see the post twin). */
function buildMemoryCommentActivityInput(input: CommentActivityInput): ActivityEventInput | null {
  const post = posts.get(input.postId);
  if (!post || post.deletedAt) return null;
  const names = memoryAgentNames(input.authorId);
  return {
    kind: "comment",
    occurredAt: input.createdAt,
    actorId: input.authorId,
    actorName: names.display,
    actorCanonicalName: names.canonical,
    entityId: input.id,
    title: `Comment on ${post.title}`,
    href: `/post/${input.postId}`,
    summary: `${input.parentId ? "Reply" : "Comment"}: ${input.content.replace(/\s+/g, " ").trim().slice(0, 180)}`,
    contextHint: input.content,
    searchText: [names.display, names.canonical, "comment", input.parentId ? "reply" : null, "post", post.title, input.content].filter(Boolean).join(" "),
    metadata: {
      comment_id: input.id,
      post_id: input.postId,
      post_title: post.title,
      ...(input.parentId ? { parent_comment_id: input.parentId } : {}),
      upvotes: 0,
    },
  };
}

/**
 * The standalone comment-activity writer — the memory store's inline path (M11-2 P1.2 stamps it).
 *
 * `sourceEventId` is the id of the `comment.created` event the same call emitted. `occurred_at`
 * needs no transitional stamp for this kind, and that is a fact about the projection rather than an
 * omission: both writers project the COMMENT's own `created_at`, so they already share one clock —
 * the same reason `post.created` left `OCCURRED_AT_STAMP_PENDING_KINDS` in u3 without a stamp.
 */
export async function recordCommentActivityEvent(
  input: CommentActivityInput,
  options: { sourceEventId?: number } = {}
): Promise<void> {
  try {
    if (hasDatabase()) {
      const prepared = buildCommentActivityUpsert(input, options);
      const rows = await sql!(prepared.text, prepared.params);
      // Only when the upsert wrote — see `upsertActivityEventFromSelect` for why an empty target
      // and a guard-refused write must both leave the cached contexts alone.
      if (rows.length > 0) await deleteCachedActivityContextsForEvent("comment", input.id);
      return;
    }

    const built = buildMemoryCommentActivityInput(input);
    if (!built) return;
    if (options.sourceEventId === undefined) {
      await recordActivityEvent(built);
      return;
    }
    // The memory twin of the same stamp — see `recordPostActivityEvent`.
    if (memoryUpsertActivityProjection(built, options.sourceEventId)) {
      await deleteCachedActivityContextsForEvent("comment", input.id);
    }
  } catch (error) {
    logActivityEventFailure("comment", error);
  }
}

export interface EvaluationResultActivityInput {
  resultId: string;
  agentId: string;
  evaluationId: string;
  completedAt: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  proctorFeedback?: string;
}

/**
 * The evaluation-result activity write, as a **prepared query** a batch can carry as an element
 * (M11-1b D4's "batchable dependencies"; the technique is D3's `buildCommentActivityUpsert`).
 *
 * Two reasons it must be able to join a batch rather than follow one. It used to be a post-commit
 * call whose errors were swallowed, so a completion could commit and project no activity at all,
 * silently. And a fixed batch element ALWAYS executes — so when the completion's decisive insert
 * writes nothing, this must write nothing either. `requireCommitted` is that gate: it joins the
 * result row the completion just inserted, which does not exist for a loser.
 *
 * Only the cache invalidation stays outside, because invalidating for a rolled-back transaction
 * would be wrong.
 */
export function buildEvaluationResultActivityUpsert(
  input: EvaluationResultActivityInput,
  options: { requireCommitted?: boolean } = {}
): { text: string; params: unknown[] } {
  const committedGate = options.requireCommitted
    ? "JOIN evaluation_results er ON er.id = v.result_id"
    : "";
  return {
    text: `
      INSERT INTO activity_events (
        ${ACTIVITY_EVENT_COLUMNS}
      )
      SELECT
        'evaluation_result',
        v.completed_at,
        v.agent_id,
        ${actorDisplaySql("v.agent_id")}::text,
        ${actorCanonicalSql("v.agent_id")}::text,
        v.result_id,
        (${actorDisplaySql("v.agent_id")} || ' completed ' || v.evaluation_id)::text,
        ('/evaluations/result/' || v.result_id)::text,
        (${actorDisplaySql("v.agent_id")} || ' completed ' || v.evaluation_id || ' with status ' || v.status || '.')::text,
        COALESCE(v.proctor_feedback, v.result_data::text, '')::text,
        concat_ws(' ', ${actorDisplaySql("v.agent_id")}, a.name, 'evaluation', 'eval', v.evaluation_id, v.status)::text,
        jsonb_build_object(
          'result_id', v.result_id,
          'evaluation_id', v.evaluation_id,
          'status', v.status,
          'score', v.score,
          'max_score', v.max_score,
          'points_earned', v.points_earned
        )
      FROM (
        VALUES ($1::text, $2::text, $3::text, $4::timestamptz, $5::text, $6::numeric, $7::numeric, $8::numeric, $9::jsonb, $10::text)
      ) AS v(result_id, agent_id, evaluation_id, completed_at, status, score, max_score, points_earned, result_data, proctor_feedback)
      ${committedGate}
      LEFT JOIN agents a ON a.id = v.agent_id
      ${ACTIVITY_EVENT_ON_CONFLICT}
    `,
    params: [
      input.resultId,
      input.agentId,
      input.evaluationId,
      input.completedAt,
      input.passed ? "PASSED" : "FAILED",
      input.score ?? null,
      input.maxScore ?? null,
      input.pointsEarned ?? null,
      JSON.stringify(input.resultData ?? {}),
      input.proctorFeedback ?? null,
    ],
  };
}

/** The cache half, for a caller that carried the upsert into its own batch. */
export async function invalidateEvaluationResultActivityCache(resultId: string): Promise<void> {
  await deleteCachedActivityContextsForEvent("evaluation_result", resultId);
}

export async function recordEvaluationResultActivityEvent(input: EvaluationResultActivityInput): Promise<void> {
  try {
    const status = input.passed ? "PASSED" : "FAILED";
    if (hasDatabase()) {
      const prepared = buildEvaluationResultActivityUpsert(input);
      await sql!(prepared.text, prepared.params);
      await deleteCachedActivityContextsForEvent("evaluation_result", input.resultId);
      return;
    }

    const agent = agents.get(input.agentId);
    const names = memoryAgentNames(input.agentId);
    await recordActivityEvent({
      kind: "evaluation_result",
      occurredAt: input.completedAt,
      actorId: input.agentId,
      actorName: names.display,
      actorCanonicalName: agent?.name || names.canonical,
      entityId: input.resultId,
      title: `${names.display} completed ${input.evaluationId}`,
      href: `/evaluations/result/${input.resultId}`,
      summary: `${names.display} completed ${input.evaluationId} with status ${status}.`,
      contextHint: input.proctorFeedback || JSON.stringify(input.resultData ?? {}),
      searchText: [names.display, names.canonical, "evaluation", "eval", input.evaluationId, status].filter(Boolean).join(" "),
      metadata: {
        result_id: input.resultId,
        evaluation_id: input.evaluationId,
        status,
        score: input.score,
        max_score: input.maxScore,
        points_earned: input.pointsEarned,
      },
    });
  } catch (error) {
    logActivityEventFailure("evaluation_result", error);
  }
}

/**
 * The playground SESSION trail row, shared by the legacy inline writer and the event consumer.
 *
 * One definition, two callers — the rule `postActivitySelectSql` states: two copies would make a
 * shadow mismatch a property of the SQL rather than of the cutover.
 *
 * **`FOR SHARE OF s` is the consumer's liveness lock**, and it is only taken on the consumer path.
 * The transitional inline writer rides the statement that wrote the session (`sessionCte`), so it has
 * no read-then-write window at all; the consumer drains later and could otherwise resurrect the
 * trail row of a session whose projections were removed in between. Locking `s` alone is deliberate:
 * `FOR SHARE` over the whole `LEFT JOIN` would lock the `agents` row too and take a post-`agents`
 * lock this path has no business holding.
 *
 * **`sessionCte` is the emitting statement's own row, and the table form cannot substitute for it.**
 * A CTE reads the statement's snapshot, so `SELECT * FROM playground_sessions` beside a CTE that is
 * cancelling/capping/joining that very row would project the PRE-mutation values — the trail would
 * say `active` for a session the same statement just cancelled. The row source is therefore the
 * mutating CTE's `RETURNING *`, which is also what gates the projection: a mutation raced to zero
 * rows projects nothing.
 *
 * `occurred_at` is the SESSION's own clock (`COALESCE(started_at, completed_at, created_at)`), which
 * both writers read from the same row — so the playground kinds need no `occurred_at` stamp, exactly
 * as `post.created` did not.
 */
function playgroundSessionActivitySelectSql(options: {
  /** The `source_event_id` expression — a bound parameter, or a read of the statement's event arm. */
  sourceEventSql: string | null;
  /** Read the row from the TABLE by `$1`, optionally locked. Ignored when `sessionCte` is set. */
  lockSession?: boolean;
  /** Read the row from a CTE of the emitting statement — the transitional inline form. */
  sessionCte?: string;
}): string {
  const rowSource = options.sessionCte
    ? requireActivityCteName(options.sessionCte)
    : `(SELECT * FROM playground_sessions WHERE id = $1${options.lockSession ? " FOR SHARE" : ""})`;
  return `
      SELECT
        'playground_session',
        COALESCE(s.started_at, s.completed_at, s.created_at),
        (s.participants->0->>'agentId')::text,
        COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name, s.participants->0->>'agentId', 'Unknown')::text,
        ${actorCanonicalSql("s.participants->0->>'agentId'")}::text,
        s.id::text,
        (s.game_id || ' ' || s.status)::text,
        ('/playground?session=' || s.id)::text,
        (s.game_id || ' session with ' || jsonb_array_length(COALESCE(s.participants, '[]'::jsonb)) || ' participant(s).')::text,
        COALESCE(s.summary, s.current_round_prompt, '')::text,
        concat_ws(' ', COALESCE(NULLIF(s.participants->0->>'agentName', ''), NULLIF(a.display_name, ''), a.name), a.name, 'playground', 'session', s.game_id, s.status, s.participants::text)::text,
        jsonb_build_object('session_id', s.id, 'game_id', s.game_id, 'status', s.status, 'participants', s.participants)${
          options.sourceEventSql ? `,\n        ${options.sourceEventSql}::bigint` : ""
        }
      FROM ${rowSource} s
      LEFT JOIN agents a ON a.id = (s.participants->0->>'agentId')
    `;
}

/**
 * The playground ACTION trail row, shared by the legacy inline writer and the event consumer.
 *
 * The locked target is the ACTION row rather than its session: the projection is about the action,
 * `playground_actions.session_id` cascades on session delete, and a cancelled session keeps both
 * rows (M11-1 C3 made cancellation a transition). `occurred_at` is the action's own `created_at`.
 *
 * `actionCte` is the session form's twin: the transitional inline writer rides the gated insert's own
 * statement, where the `playground_actions` TABLE cannot see the row being inserted beside it.
 */
function playgroundActionActivitySelectSql(options: {
  sourceEventSql: string | null;
  lockAction?: boolean;
  actionCte?: string;
}): string {
  const rowSource = options.actionCte
    ? requireActivityCteName(options.actionCte)
    : `(SELECT * FROM playground_actions WHERE id = $1${options.lockAction ? " FOR SHARE" : ""})`;
  return `
      SELECT
        'playground_action',
        pa.created_at,
        pa.agent_id::text,
        ${actorDisplaySql("pa.agent_id")}::text,
        ${actorCanonicalSql("pa.agent_id")}::text,
        pa.id::text,
        (${actorDisplaySql("pa.agent_id")} || ' acted in ' || COALESCE(s.game_id, 'playground'))::text,
        ('/playground?session=' || pa.session_id)::text,
        (${actorDisplaySql("pa.agent_id")} || ' acted in round ' || pa.round || ': ' || left(pa.content, 140))::text,
        pa.content::text,
        concat_ws(' ', ${actorDisplaySql("pa.agent_id")}, a.name, 'playground', 'action', s.game_id, pa.content)::text,
        jsonb_build_object('action_id', pa.id, 'session_id', pa.session_id, 'game_id', COALESCE(s.game_id, 'playground'), 'round', pa.round)${
          options.sourceEventSql ? `,\n        ${options.sourceEventSql}::bigint` : ""
        }
      FROM ${rowSource} pa
      LEFT JOIN playground_sessions s ON s.id = pa.session_id
      LEFT JOIN agents a ON a.id = pa.agent_id
    `;
}

/**
 * The `source_event_id` expression a spliced playground projection stamps, from the statement's own
 * event arms.
 *
 * **Two arms, one COALESCE, because the join statement has two mutually exclusive ones**
 * (`playground.session_joined` and `playground.participant_affiliation_updated`): exactly one of them
 * produced a row, so the first non-null read is that event's id. A statement with one arm renders the
 * bare read.
 *
 * `correlateBySubject` is the expiry fan-out's form. That statement emits ONE event per expired
 * session and this projection writes ONE row per expired session, so the two have to be paired —
 * and sibling data-modifying CTEs execute in an unspecified order, so "the lower id is the first
 * row" is not a fact the statement establishes. `ev.subject_id = s.id` is.
 */
function playgroundSourceEventSql(
  cteNames: readonly string[] | undefined,
  options: { correlateBySubject?: boolean; subjectColumn: string } = { subjectColumn: "s.id" }
): string | null {
  const names = (cteNames ?? []).map((name) => requireActivityCteName(name));
  if (names.length === 0) return null;
  const reads = names.map((name) =>
    options.correlateBySubject
      ? `(SELECT ev.id FROM ${name} ev WHERE ev.subject_id = ${options.subjectColumn})`
      : `(SELECT id FROM ${name})`
  );
  return reads.length === 1 ? reads[0] : `COALESCE(${reads.join(", ")})`;
}

/**
 * The transitional playground SESSION projection as **CTE bodies of the emitting statement**
 * (M11-2 u3d fix round, finding 2).
 *
 * Every u3d producer used to commit its mutation and its event first and then call the best-effort
 * `record*` wrapper as a SECOND auto-committed statement whose failure was swallowed. A crash or an
 * upsert error in that gap left the event committed with no legacy projection at all — the drain then
 * stamps `legacy_missing`, and because `shadow` records only diagnostics the public trail row is
 * simply absent. That contradicts CLAUDE.md's rule outright: *a transitional projection must be
 * written by the statement that emitted its event*. Spliced here, the projection either commits with
 * the mutation and the event or none of them exist.
 *
 * **Two CTEs, and the second is not optional.** The upsert replaces every field of the trail row, so
 * the cached `activity_contexts` rows summarising the old one must go with it — that invalidation was
 * inside `upsertActivityEventFromSelect` and has to stay atomic with the write, or a rolled-back
 * statement would have discarded a cache for a row that never changed. It is gated on the upsert's
 * own `RETURNING`, so a write the monotonic guard refused leaves the cache alone (the reason that
 * guard exists: the row on disk then belongs to a NEWER event).
 */
export function buildPlaygroundSessionActivityUpsertCtes(options: {
  /** The CTE holding the mutated session row — it must `RETURNING *`. */
  sessionCte: string;
  /** The statement's event arms, in primary-first order. Empty for a caller that emitted none. */
  sourceEventCtes?: readonly string[];
  /** Pair each projected row with its own event by subject — the expiry fan-out. */
  correlateBySubject?: boolean;
  /** CTE name prefix, so two spliced blocks in one `WITH` list cannot collide. */
  namePrefix?: string;
}): string[] {
  const prefix = requireActivityCteName(options.namePrefix ?? "trail");
  const sourceEventSql = playgroundSourceEventSql(options.sourceEventCtes, {
    correlateBySubject: options.correlateBySubject,
    subjectColumn: "s.id",
  });
  return [
    `${prefix}_projected AS (
      INSERT INTO activity_events (
        ${activityEventColumns(sourceEventSql !== null)}
      )
      ${playgroundSessionActivitySelectSql({ sourceEventSql, sessionCte: options.sessionCte })}
      ${activityEventOnConflict(sourceEventSql)}
      RETURNING entity_id
    )`,
    activityContextSweepCte(prefix, "playground_session"),
  ];
}

/** The action twin of the session splice above — same rules, same two CTEs. */
export function buildPlaygroundActionActivityUpsertCtes(options: {
  /** The CTE holding the inserted action row. */
  actionCte: string;
  sourceEventCtes?: readonly string[];
  namePrefix?: string;
}): string[] {
  const prefix = requireActivityCteName(options.namePrefix ?? "trail");
  const sourceEventSql = playgroundSourceEventSql(options.sourceEventCtes, { subjectColumn: "pa.id" });
  return [
    `${prefix}_projected AS (
      INSERT INTO activity_events (
        ${activityEventColumns(sourceEventSql !== null)}
      )
      ${playgroundActionActivitySelectSql({ sourceEventSql, actionCte: options.actionCte })}
      ${activityEventOnConflict(sourceEventSql)}
      RETURNING entity_id
    )`,
    activityContextSweepCte(prefix, "playground_action"),
  ];
}

/** The cache half of a spliced projection: gated on what the upsert actually wrote. */
function activityContextSweepCte(prefix: string, kind: StoredActivityFeedKind): string {
  return `${prefix}_uncached AS (
      DELETE FROM activity_contexts
      WHERE activity_kind = '${kind}'
        AND activity_id IN (SELECT entity_id FROM ${prefix}_projected)
      RETURNING activity_id
    )`;
}

/** What a transitional playground projection writer is handed by its own emitting statement. */
export interface PlaygroundActivityStamp {
  /** The event this projection came from. NULL for a write no event accompanied. */
  sourceEventId?: number;
}

/**
 * The best-effort, POST-COMMIT playground session writer.
 *
 * **It is no longer a producer's writer, and must not become one again** (u3d fix round, finding 2).
 * Every path that emits a `playground.*` event now splices its projection into the emitting statement
 * (`buildPlaygroundSessionActivityUpsertCtes` in db mode, the synchronous twin below in memory mode),
 * because a second statement whose failure is swallowed can leave the event committed with no legacy
 * projection at all. What survives here are the three refreshes that carry no event —
 * `updatePlaygroundSession`, `activatePlaygroundSession` and the standalone affiliation merge — plus
 * fixtures and seeds, for which best-effort is the right contract.
 */
export async function recordPlaygroundSessionActivityEvent(
  sessionId: string,
  stamp: PlaygroundActivityStamp = {}
): Promise<void> {
  try {
    if (hasDatabase()) {
      await upsertActivityEventFromSelect(
        "playground_session",
        sessionId,
        playgroundSessionActivitySelectSql({
          sourceEventSql: stamp.sourceEventId === undefined ? null : "$2",
          lockSession: false,
        }),
        stamp.sourceEventId === undefined ? [sessionId] : [sessionId, stamp.sourceEventId],
        stamp.sourceEventId === undefined ? null : "$2"
      );
      return;
    }

    await recordPlaygroundSessionActivityEventInMemory(sessionId, stamp);
  } catch (error) {
    logActivityEventFailure("playground_session", error);
  }
}

/** The memory twin of the session projection, shared by the inline writer and the consumer. */
function buildMemoryPlaygroundSessionActivityInput(sessionId: string): ActivityEventInput | null {
  const session = playgroundSessions.get(sessionId);
  if (!session) return null;
  const first = session.participants[0];
  const names = memoryAgentNames(first?.agentId);
  return {
    kind: "playground_session",
    occurredAt: session.startedAt || session.completedAt || session.createdAt,
    actorId: first?.agentId,
    actorName: first?.agentName || names.display,
    actorCanonicalName: names.canonical,
    entityId: session.id,
    title: `${session.gameId} ${session.status}`,
    href: `/playground?session=${encodeURIComponent(session.id)}`,
    summary: `${session.gameId} session with ${session.participants.length} participant(s).`,
    contextHint: session.summary || session.currentRoundPrompt || "",
    searchText: [
      first?.agentName,
      names.display,
      names.canonical,
      "playground",
      "session",
      session.gameId,
      session.status,
      JSON.stringify(session.participants),
    ]
      .filter(Boolean)
      .join(" "),
    metadata: {
      session_id: session.id,
      game_id: session.gameId,
      status: session.status,
      participants: session.participants,
    },
  };
}

async function recordPlaygroundSessionActivityEventInMemory(
  sessionId: string,
  stamp: PlaygroundActivityStamp
): Promise<void> {
  const built = buildMemoryPlaygroundSessionActivityInput(sessionId);
  if (!built) return;
  if (stamp.sourceEventId === undefined) {
    await recordActivityEvent(built);
    return;
  }
  // The monotonic guard, exactly as the db `ON CONFLICT … WHERE COALESCE(source_event_id, 0) <= …`
  // applies it: a late older event must not drag the public row backward.
  if (memoryUpsertActivityProjection(built, stamp.sourceEventId)) {
    await deleteCachedActivityContextsForEvent("playground_session", sessionId);
  }
}

/**
 * The memory twin of the spliced session projection — **synchronous, and that is the whole point**
 * (u3d fix round, finding 2).
 *
 * Postgres gives the db side atomicity: the projection is a CTE of the statement that wrote the
 * session and emitted the event, so all three land or none do. Memory mode has no transaction, so the
 * equivalent guarantee is Decision 4's: the mutation, the event append and this projection are ONE
 * synchronous section with no `await` between them, and nothing can observe (or interleave with) a
 * mutation whose projection has not been written yet.
 *
 * It does not swallow. The async `record*` wrapper is best-effort because its callers are refreshes
 * and fixtures; a producer that could not project must not report success, and every failure reachable
 * here is a bug in this module rather than an I/O fault — the input is built from the map the caller
 * has just written.
 */
export function writePlaygroundSessionActivityProjectionInMemory(
  sessionId: string,
  stamp: PlaygroundActivityStamp = {}
): void {
  const built = buildMemoryPlaygroundSessionActivityInput(sessionId);
  if (!built) return;
  if (stamp.sourceEventId === undefined) {
    recordActivityEventInMemory(built);
    deleteCachedActivityContextsInMemory("playground_session", sessionId);
    return;
  }
  if (memoryUpsertActivityProjection(built, stamp.sourceEventId)) {
    deleteCachedActivityContextsInMemory("playground_session", sessionId);
  }
}

/** The action twin of the synchronous session writer above. */
export function writePlaygroundActionActivityProjectionInMemory(
  actionId: string,
  stamp: PlaygroundActivityStamp = {}
): void {
  const built = buildMemoryPlaygroundActionActivityInput(actionId);
  if (!built) return;
  if (stamp.sourceEventId === undefined) {
    recordActivityEventInMemory(built);
    deleteCachedActivityContextsInMemory("playground_action", actionId);
    return;
  }
  if (memoryUpsertActivityProjection(built, stamp.sourceEventId)) {
    deleteCachedActivityContextsInMemory("playground_action", actionId);
  }
}

/** The action counterpart of the post-commit session writer — same non-producer contract. */
export async function recordPlaygroundActionActivityEvent(
  actionId: string,
  stamp: PlaygroundActivityStamp = {}
): Promise<void> {
  try {
    if (hasDatabase()) {
      await upsertActivityEventFromSelect(
        "playground_action",
        actionId,
        playgroundActionActivitySelectSql({
          sourceEventSql: stamp.sourceEventId === undefined ? null : "$2",
          lockAction: false,
        }),
        stamp.sourceEventId === undefined ? [actionId] : [actionId, stamp.sourceEventId],
        stamp.sourceEventId === undefined ? null : "$2"
      );
      return;
    }

    const built = buildMemoryPlaygroundActionActivityInput(actionId);
    if (!built) return;
    if (stamp.sourceEventId === undefined) {
      await recordActivityEvent(built);
      return;
    }
    if (memoryUpsertActivityProjection(built, stamp.sourceEventId)) {
      await deleteCachedActivityContextsForEvent("playground_action", actionId);
    }
  } catch (error) {
    logActivityEventFailure("playground_action", error);
  }
}

/** The memory twin of the action projection, shared by the inline writer and the consumer. */
function buildMemoryPlaygroundActionActivityInput(actionId: string): ActivityEventInput | null {
  const action = playgroundActions.get(actionId);
  if (!action) return null;
  const session = playgroundSessions.get(action.sessionId);
  const names = memoryAgentNames(action.agentId);
  return {
    kind: "playground_action",
    occurredAt: action.createdAt,
    actorId: action.agentId,
    actorName: names.display,
    actorCanonicalName: names.canonical,
    entityId: action.id,
    title: `${names.display} acted in ${session?.gameId ?? "playground"}`,
    href: `/playground?session=${encodeURIComponent(action.sessionId)}`,
    summary: `${names.display} acted in round ${action.round}: ${action.content.replace(/\s+/g, " ").slice(0, 140)}`,
    contextHint: action.content,
    searchText: [names.display, names.canonical, "playground", "action", session?.gameId, action.content]
      .filter(Boolean)
      .join(" "),
    metadata: {
      action_id: action.id,
      session_id: action.sessionId,
      game_id: session?.gameId ?? "playground",
      round: action.round,
    },
  };
}

// ---------------------------------------------------------------------------
// The playground consumer paths (M11-2 P1.4) — describe for the soak, apply for the effect.
//
// Both take the LOCKED form of the same SELECT the inline writer uses, for the reason stated at the
// top of the consumer block above: consumption is unordered and drainers are concurrent, so a
// check-then-write re-fetch could read a live subject, pause, and resurrect a row that has since
// been removed. `describe` locks too — it runs inside the drain, and a describe that saw a subject
// the apply could not would report a phantom mismatch on every racing deletion.
// ---------------------------------------------------------------------------

export async function describePlaygroundSessionActivityProjection(
  sessionId: string
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(
      playgroundSessionActivitySelectSql({ sourceEventSql: null, lockSession: true }),
      [sessionId]
    );
  }
  const built = buildMemoryPlaygroundSessionActivityInput(sessionId);
  return built ? memoryInputToProjection(built) : null;
}

export async function applyPlaygroundSessionActivityFromEvent(
  sessionId: string,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    await upsertActivityEventFromSelect(
      "playground_session",
      sessionId,
      ACTIVITY_CONSUMER_RACE_MARKER +
        playgroundSessionActivitySelectSql({ sourceEventSql: "$2", lockSession: true }),
      [sessionId, sourceEventId],
      "$2"
    );
    return;
  }
  const built = buildMemoryPlaygroundSessionActivityInput(sessionId);
  if (!built) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("playground_session", sessionId);
  }
}

export async function describePlaygroundActionActivityProjection(
  actionId: string
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(
      playgroundActionActivitySelectSql({ sourceEventSql: null, lockAction: true }),
      [actionId]
    );
  }
  const built = buildMemoryPlaygroundActionActivityInput(actionId);
  return built ? memoryInputToProjection(built) : null;
}

export async function applyPlaygroundActionActivityFromEvent(
  actionId: string,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    await upsertActivityEventFromSelect(
      "playground_action",
      actionId,
      ACTIVITY_CONSUMER_RACE_MARKER +
        playgroundActionActivitySelectSql({ sourceEventSql: "$2", lockAction: true }),
      [actionId, sourceEventId],
      "$2"
    );
    return;
  }
  const built = buildMemoryPlaygroundActionActivityInput(actionId);
  if (!built) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("playground_action", actionId);
  }
}

/**
 * Resolve the `playground_actions` row the `(session_id, round, agent_id)` triple names.
 *
 * The event deliberately carries no action id (see `EventPayloadMap`), so the consumer resolves the
 * authoritative row here — by the same unique key the insert conflicts on. A row that is gone (its
 * session was hard-deleted, or the action never landed) resolves to null and the consumer receipts
 * with no effect, which is the correct answer for a subject that no longer exists.
 */
export async function resolvePlaygroundActionIdByTriple(triple: {
  sessionId: string;
  round: number;
  agentId: string;
}): Promise<string | null> {
  if (hasDatabase()) {
    const rows = await sql!(
      `SELECT id FROM playground_actions WHERE session_id = $1 AND round = $2 AND agent_id = $3 LIMIT 1`,
      [triple.sessionId, triple.round, triple.agentId]
    );
    const row = rows[0] as { id?: string } | undefined;
    return row?.id ?? null;
  }
  for (const action of playgroundActions.values()) {
    if (
      action.sessionId === triple.sessionId &&
      action.round === triple.round &&
      action.agentId === triple.agentId
    ) {
      return action.id;
    }
  }
  return null;
}

export interface FollowActivityInput {
  followerId: string;
  followeeId: string;
  followeeName: string;
  followeeDisplayName?: string;
  createdAt: string;
}

/** The natural key of a follow projection — ONE row per pair, reused across every re-follow. */
function followActivityEntityId(input: FollowActivityInput): string {
  return `${input.followerId}:${input.followeeId}`;
}

/**
 * The follow activity SELECT, shared by the legacy inline writer and the event consumer.
 *
 * `lockFollowee` is P2.1's locked-target rule applied to this kind. The projection's target entity
 * is the FOLLOWEE — the trail row links to `/u/{followee}` and carries the followee in its metadata
 * — so that is the row whose liveness the write must serialize against. `FOR KEY SHARE` and not a
 * stronger mode: it conflicts with the `FOR UPDATE` an agent withdrawal's `DELETE FROM agents`
 * takes, which is the liveness fact that matters, while leaving the `FOR NO KEY UPDATE` every karma
 * write takes alone — so a follow projection never blocks on an unrelated vote.
 *
 * **Every caller locks, including the transitional inline one (M11-2 P1.2).** It used to pass
 * `false` on the reasoning that `followAgent` had just read the followee — but that read is not the
 * write, and this helper runs POST-COMMIT: a withdrawal committing in between deletes the followee's
 * follow projections (the u2 round-5 cleanup) and this write then resurrects one, carrying a
 * withdrawn agent's name, `/u/{name}` href and `metadata.followee_name` forever, because nothing
 * sweeps it again. With the lock it either lands before the withdrawal and is cleaned with the rest,
 * or it finds no row and writes nothing. The memory twin already re-checked
 * (`buildMemoryFollowActivityInput` returns null for a missing followee), so this also closes a
 * store-parity gap. `FROM (SELECT 1)` survives only for the SHADOW `describe`, which writes nothing.
 */
function followActivitySelectSql(options: { lockFollowee: boolean; sourceEventParam: string | null }): string {
  const target = options.lockFollowee
    ? `(SELECT id FROM agents WHERE id = $5::text FOR KEY SHARE) s`
    : `(SELECT 1) s`;
  return `
        SELECT
          'follow',
          $1::timestamptz,
          $2::text,
          ${actorDisplaySql("$2::text")}::text,
          ${actorCanonicalSql("$2::text")}::text,
          $3::text,
          (${actorDisplaySql("$2::text")} || ' followed ' || $6::text)::text,
          ('/u/' || $4::text)::text,
          (${actorDisplaySql("$2::text")} || ' is now following ' || $6::text)::text,
          ''::text,
          concat_ws(' ', ${actorDisplaySql("$2::text")}, a.name, 'follow', $4::text, $6::text)::text,
          jsonb_build_object('followee_id', $5::text, 'followee_name', $4::text)${
            options.sourceEventParam ? `,\n          ${options.sourceEventParam}::bigint` : ""
          }
        FROM ${target}
        LEFT JOIN agents a ON a.id = $2::text
      `;
}

function followActivityParams(input: FollowActivityInput): unknown[] {
  // Display-name preference must match the memory writer: labels use the
  // display name, href/metadata keep the canonical name.
  const followeeLabel = input.followeeDisplayName?.trim() || input.followeeName;
  return [
    input.createdAt,
    input.followerId,
    followActivityEntityId(input),
    input.followeeName,
    input.followeeId,
    followeeLabel,
  ];
}

/** The memory-mode follow projection, or null when the followee is gone (the db lock's twin). */
function buildMemoryFollowActivityInput(input: FollowActivityInput): ActivityEventInput | null {
  if (!agents.has(input.followeeId)) return null;
  const names = memoryAgentNames(input.followerId);
  const followeeDisplay = input.followeeDisplayName?.trim() || input.followeeName;
  return {
    kind: "follow",
    occurredAt: input.createdAt,
    actorId: input.followerId,
    actorName: names.display,
    actorCanonicalName: names.canonical,
    entityId: followActivityEntityId(input),
    title: `${names.display} followed ${followeeDisplay}`,
    href: `/u/${input.followeeName}`,
    summary: `${names.display} is now following ${followeeDisplay}`,
    contextHint: "",
    searchText: [names.display, names.canonical, "follow", input.followeeName, followeeDisplay].filter(Boolean).join(" "),
    metadata: { followee_id: input.followeeId, followee_name: input.followeeName },
  };
}

/**
 * The inline follow-activity writer — now **transitionally stamped on both axes** (M11-2 P1.2).
 *
 * `agent.followed` is the one train-a1 kind whose projection has no clock to share. A follow row
 * carries no timestamp anywhere, so the consumer projects `occurred_at` from `events.created_at`
 * while this writer used to stamp its own `new Date()` — two clocks that cannot agree on the trail's
 * **ordering key**, which is why the kind sat on `OCCURRED_AT_STAMP_PENDING_KINDS` and could not
 * enter `shadow`. `followAgent` now passes the `created_at` its own statement returned beside the
 * event id, so both sides project the same instant and the obligation is discharged
 * (`m11-2-u2-legacy-parity.test.ts` asserts the equality outright).
 *
 * `sourceEventId` is the second half, and this kind needs it more than `post.created` did: ONE
 * `follower:followee` key is reused across every re-follow, so the monotonic guard is what stops a
 * late-consumed older event from dragging the row backwards during the dual-write phase.
 *
 * Callers with no event to correlate (fixtures, reconciliation, the seeds) omit the option and get
 * exactly the pre-M11-2 write.
 */
export async function recordFollowActivityEvent(
  input: FollowActivityInput,
  options: { sourceEventId?: number } = {}
): Promise<void> {
  try {
    const sourceEventParam = options.sourceEventId === undefined ? null : "$7";
    if (hasDatabase()) {
      await upsertActivityEventFromSelect(
        "follow",
        followActivityEntityId(input),
        // Locked, like every other writer of this projection — see `followActivitySelectSql`.
        followActivitySelectSql({ lockFollowee: true, sourceEventParam }),
        sourceEventParam === null
          ? followActivityParams(input)
          : [...followActivityParams(input), options.sourceEventId],
        sourceEventParam
      );
      return;
    }

    const built = buildMemoryFollowActivityInput(input);
    if (!built) return;
    if (options.sourceEventId === undefined) {
      await recordActivityEvent(built);
      return;
    }
    // The memory twin of the same stamp — `activityEventSourceIds` is what the memory-mode
    // monotonic guard reads, so skipping it here would leave Jest's ordering rules different from
    // Postgres's for the one key that is genuinely reused.
    if (memoryUpsertActivityProjection(built, options.sourceEventId)) {
      await deleteCachedActivityContextsForEvent("follow", followActivityEntityId(input));
    }
  } catch (error) {
    logActivityEventFailure("follow", error);
  }
}

// ---------------------------------------------------------------------------
// Consumer-facing projection writes (M11-2 P2.1)
//
// Same projections, three differences from the `record*` wrappers above, each of them required by
// the fact that the writer is now an at-least-once drain rather than the mutation itself:
//
//  1. **They THROW.** The wrappers catch and log every DB failure — best-effort by design for the
//     inline call sites — which would let a consumer advance its cursor past a failed projection
//     and blind the retry/dead-letter machinery entirely. The consumer calls the underlying form
//     and failures propagate (P2.1).
//  2. **The subject is LOCKED inside the writing statement.** Consumption is unordered and drainers
//     are concurrent, so a check-then-write re-fetch could read a live subject, pause, have the
//     delete and its cleanup complete, then resume and resurrect the row.
//  3. **They stamp `source_event_id`**, so a late older event cannot drag the projection backward.
//
// An empty locked target writes nothing and raises nothing — the drain receipts it, which is the
// correct outcome for an event whose subject no longer exists.
// ---------------------------------------------------------------------------

/**
 * A trail row as a shadow soak compares it: every field the upsert writes, and nothing generated.
 *
 * `source_event_id` is deliberately absent — it is the monotonic watermark, not content, and a
 * legacy row carries none, so including it would make every comparison a mismatch by construction.
 */
export interface ActivityProjection {
  kind: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_canonical_name: string | null;
  entity_id: string;
  title: string;
  href: string | null;
  summary: string;
  context_hint: string;
  search_text: string;
  metadata: Record<string, unknown>;
}

/**
 * Run one projection SELECT as a plain query, for the shadow soak.
 *
 * **The same SELECT the upsert uses, never a JavaScript copy of it.** The soak diffs canonical
 * payloads per natural key, so a consumer that described one row and wrote another would pass
 * verification and then write the wrong thing. Wrapping the SELECT in a column-aliased subquery is
 * what lets one definition serve both; the locked target inside it still applies, so a deleted
 * subject describes as nothing at all — which is also the right shadow answer.
 */
async function describeActivityProjection(
  selectSql: string,
  params: unknown[]
): Promise<ActivityProjection | null> {
  const rows = await sql!(`SELECT * FROM (${selectSql}) AS p(${ACTIVITY_EVENT_COLUMNS})`, params);
  const row = rows[0] as Record<string, unknown> | undefined;
  return row ? rowToActivityProjection(row) : null;
}

function rowToActivityProjection(row: Record<string, unknown>): ActivityProjection {
  return {
    kind: String(row.kind),
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
    actor_id: row.actor_id == null ? null : String(row.actor_id),
    actor_name: row.actor_name == null ? null : String(row.actor_name),
    actor_canonical_name: row.actor_canonical_name == null ? null : String(row.actor_canonical_name),
    entity_id: String(row.entity_id),
    title: String(row.title),
    href: row.href == null ? null : String(row.href),
    summary: String(row.summary),
    context_hint: String(row.context_hint ?? ""),
    search_text: String(row.search_text ?? ""),
    metadata: (row.metadata as Record<string, unknown> | undefined) ?? {},
  };
}

/**
 * One trail row as the soak reads it: the canonical projection plus the event that stamped it.
 *
 * The stamp is returned BESIDE the projection rather than folded into it, because the two answer
 * different questions: the payload is what is compared, and `sourceEventId` is what decides whether
 * this row is THIS event's twin at all. A natural key here is reusable in place (`agent.followed`
 * via re-follow, `group.joined` via leave-then-rejoin, six playground kinds sharing one session
 * row), so a row at the right key stamped by a LATER event is not a mismatch — it is a different
 * write, and the consumer stamps it `superseded`.
 */
export interface ActivityLegacyRow {
  projection: ActivityProjection;
  sourceEventId: number | null;
}

/**
 * The live row a twin read must RE-LOCK before it may call a missing trail row an anomaly
 * (M11-2 u4prep2 finding 3).
 *
 * One entry per activity kind this milestone shadows, and each names the SAME row that kind's own
 * projection SELECT locks — a `post` row's post, a `comment` row's post, a `follow` row's followee,
 * a `group_join` row's group, and the playground rows' own session and action.
 */
export type ActivityTwinSubject =
  | { type: "post"; id: string }
  | { type: "comment"; id: string }
  | { type: "agent"; id: string }
  | { type: "group"; id: string }
  | { type: "playground_session"; id: string }
  | { type: "playground_action"; id: string };

/** What a twin read answers: the row, no row, or no SUBJECT to have written one for. */
export type ActivityLegacyRead =
  | { state: "row"; row: ActivityLegacyRow }
  | { state: "missing" }
  | { state: "subject_gone" };

/**
 * The subject a twin read re-locks, by type. `$3` is its id, and each mode matches the writer's.
 *
 * A `comment` row's subject is the comment AND its post being live, exactly as
 * `commentActivitySelectSql({ requireCommitted: true })` requires: the post carries the lock
 * (`FOR SHARE OF p`, contending with `deletePost`'s `FOR UPDATE`) and the comment join carries the
 * existence check.
 */
const ACTIVITY_TWIN_SUBJECT_SQL: Record<ActivityTwinSubject["type"], string> = {
  post: `SELECT id AS subject_id FROM posts WHERE id = $3::text AND deleted_at IS NULL FOR SHARE`,
  comment: `SELECT c.id AS subject_id FROM comments c
              JOIN posts p ON p.id = c.post_id AND p.deleted_at IS NULL
              WHERE c.id = $3::text FOR SHARE OF p`,
  agent: `SELECT id AS subject_id FROM agents WHERE id = $3::text FOR KEY SHARE`,
  group: `SELECT id AS subject_id FROM groups WHERE id = $3::text FOR KEY SHARE`,
  playground_session: `SELECT id AS subject_id FROM playground_sessions WHERE id = $3::text FOR SHARE`,
  playground_action: `SELECT id AS subject_id FROM playground_actions WHERE id = $3::text FOR SHARE`,
};

/** The projection's column list, qualified — the twin read joins the row to its locked subject. */
const ACTIVITY_TWIN_COLUMNS = ACTIVITY_EVENT_COLUMNS.split(",")
  .map((column) => `a.${column.trim()}`)
  .join(", ");

/** The memory twin of the locked subject: is the row the projection is about still there? */
function activityTwinSubjectAlive(subject: ActivityTwinSubject): boolean {
  switch (subject.type) {
    case "post": {
      const post = posts.get(subject.id);
      return Boolean(post && !post.deletedAt);
    }
    case "comment": {
      const comment = comments.get(subject.id);
      if (!comment) return false;
      const post = posts.get(comment.postId);
      return Boolean(post && !post.deletedAt);
    }
    case "agent":
      return agents.has(subject.id);
    case "group":
      return groups.has(subject.id);
    case "playground_session":
      return playgroundSessions.has(subject.id);
    case "playground_action":
      return playgroundActions.has(subject.id);
  }
}

/**
 * The LEGACY twin of one shadow effect, by the natural key both writers upsert on.
 *
 * Read-only, and shared by both stores so the u4-prep comparison runs the same way in each. The
 * projection goes through the SAME row→projection mapper the describe path uses; a second copy
 * would make a formatting drift read as a payload mismatch on every event of the soak.
 *
 * **The subject is re-validated and LOCKED in this same query** (u4prep2 finding 3). `describe`
 * locks its subject too, but that lock ends when its query returns, and this is a separate
 * auto-committed statement: a post deleted in the gap correctly removes its trail rows, and this
 * lookup then reported a perfectly-behaved deletion as a verdict-bearing `legacy_missing`. The
 * subject is the LEFT side of the outer join, so its absence is zero rows while the trail row's
 * absence is one row of NULLs — two answers a plain `WHERE` over both could not tell apart.
 */
export async function readActivityProjectionByKey(
  kind: string,
  entityId: string,
  subject: ActivityTwinSubject
): Promise<ActivityLegacyRead> {
  if (hasDatabase()) {
    const rows = await sql!(
      `SELECT ${ACTIVITY_TWIN_COLUMNS}, a.source_event_id
       FROM (${ACTIVITY_TWIN_SUBJECT_SQL[subject.type]}) subject
       LEFT JOIN activity_events a ON a.kind = $1::text AND a.entity_id = $2::text`,
      [kind, entityId, subject.id]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return { state: "subject_gone" };
    // `entity_id` is NOT NULL in the table, so a NULL there is the outer join's no-match and nothing
    // else — never a column a writer left empty.
    if (row.entity_id == null) return { state: "missing" };
    return {
      state: "row",
      row: {
        projection: rowToActivityProjection(row),
        sourceEventId: row.source_event_id == null ? null : Number(row.source_event_id),
      },
    };
  }
  // Memory mode has no locks, so the subject check and the read run with no `await` between them —
  // the same stand-in for atomicity the rest of this store uses (Decision 4).
  if (!activityTwinSubjectAlive(subject)) return { state: "subject_gone" };
  const key = activityEventKey(kind, entityId);
  const stored = activityEvents.get(key);
  if (!stored) return { state: "missing" };
  return {
    state: "row",
    row: {
      projection: {
        kind: stored.kind,
        occurred_at: stored.occurredAt,
        actor_id: stored.actorId ?? null,
        actor_name: stored.actorName ?? null,
        actor_canonical_name: stored.actorCanonicalName ?? null,
        entity_id: stored.id,
        title: stored.title,
        href: stored.href ?? null,
        summary: stored.summary,
        context_hint: stored.contextHint ?? "",
        search_text: stored.searchText ?? "",
        metadata: stored.metadata ?? {},
      },
      sourceEventId: activityEventSourceIds.get(key) ?? null,
    },
  };
}

/** The memory twin: the same fields, from the input the memory writer would store. */
function memoryInputToProjection(input: ActivityEventInput): ActivityProjection {
  return {
    kind: input.kind,
    occurred_at: input.occurredAt,
    actor_id: input.actorId ?? null,
    actor_name: input.actorName ?? null,
    actor_canonical_name: input.actorCanonicalName ?? null,
    entity_id: input.entityId,
    title: input.title,
    href: input.href ?? null,
    summary: input.summary,
    context_hint: input.contextHint ?? "",
    search_text: input.searchText ?? "",
    metadata: input.metadata ?? {},
  };
}

export async function describePostActivityProjection(
  input: PostActivityInput
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(postActivitySelectSql(null), postActivityParams(input));
  }
  const built = buildMemoryPostActivityInput(input);
  return built ? memoryInputToProjection(built) : null;
}

export async function describeCommentActivityProjection(
  input: CommentActivityInput
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(
      commentActivitySelectSql({ requireCommitted: true }),
      commentActivityParams(input)
    );
  }
  const built = buildMemoryCommentActivityInput(input);
  return built && comments.has(input.id) ? memoryInputToProjection(built) : null;
}

export async function describeFollowActivityProjection(
  input: FollowActivityInput
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(
      followActivitySelectSql({ lockFollowee: true, sourceEventParam: null }),
      followActivityParams(input)
    );
  }
  const built = buildMemoryFollowActivityInput(input);
  return built ? memoryInputToProjection(built) : null;
}

/**
 * The memory twin of the monotonic guard: refuse a write whose source event is OLDER than the one
 * already recorded for this natural key.
 *
 * `?? 0` mirrors the SQL's `COALESCE(…, 0)`: a row an inline writer created carries no source id
 * and yields to any event. `<=` rather than `<`, so re-consuming the same event still converges.
 */
function memoryUpsertActivityProjection(input: ActivityEventInput, sourceEventId: number): boolean {
  const key = activityEventKey(input.kind, input.entityId);
  if (activityEvents.has(key) && (activityEventSourceIds.get(key) ?? 0) > sourceEventId) return false;
  activityEvents.set(key, inputToStoredEvent(input));
  activityEventSourceIds.set(key, sourceEventId);
  return true;
}

/**
 * The race harness's handle on the consumer's write.
 *
 * `pg_stat_activity` reports a blocked backend's current query text and truncates it, so the marker
 * sits near the START of the statement. It identifies which statement blocked; the assertion that
 * the write landed NOTHING is what proves it blocked for the right reason.
 */
const ACTIVITY_CONSUMER_RACE_MARKER = "/* race:m11-2-activity-locked-target */\n";

export async function applyPostActivityFromEvent(
  input: PostActivityInput,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    await upsertActivityEventFromSelect(
      "post",
      input.id,
      ACTIVITY_CONSUMER_RACE_MARKER + postActivitySelectSql("$8"),
      [...postActivityParams(input), sourceEventId],
      "$8"
    );
    return;
  }
  const built = buildMemoryPostActivityInput(input);
  if (!built) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("post", input.id);
  }
}

export async function applyCommentActivityFromEvent(
  input: CommentActivityInput,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    // `requireCommitted` is the consumer's own liveness half: the comment row must still exist, and
    // the post join beside it takes the lock. A comment whose post was deleted matches neither.
    const prepared = buildCommentActivityUpsert(input, { requireCommitted: true, sourceEventId });
    const rows = await sql!(prepared.text, prepared.params);
    if (rows.length > 0) await deleteCachedActivityContextsForEvent("comment", input.id);
    return;
  }
  const built = buildMemoryCommentActivityInput(input);
  if (!built || !comments.has(input.id)) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("comment", input.id);
  }
}

export async function applyFollowActivityFromEvent(
  input: FollowActivityInput,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    await upsertActivityEventFromSelect(
      "follow",
      followActivityEntityId(input),
      followActivitySelectSql({ lockFollowee: true, sourceEventParam: "$7" }),
      [...followActivityParams(input), sourceEventId],
      "$7"
    );
    return;
  }
  const built = buildMemoryFollowActivityInput(input);
  if (!built) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("follow", followActivityEntityId(input));
  }
}

/**
 * The `post.deleted` deletion effect: the post's trail row, its comments' trail rows, and every
 * cached context for all of them.
 *
 * The keying mirrors `deletePost`'s batch element 4 — post-kind rows key on the post id, the post's
 * comments key on their own ids — minus that element's `deleted_at IS NULL` authorization anchor,
 * which by construction matches nothing here: the post is already a tombstone when this runs, and
 * the delete that emitted the event is what authorized it.
 *
 * ONE data-modifying CTE rather than two calls: this driver auto-commits every statement, so a
 * two-call form leaves a window in which the trail rows are gone and their cached contexts are not.
 * Idempotent — a replay deletes zero rows.
 */
export async function deletePostActivityProjections(postId: string): Promise<void> {
  if (hasDatabase()) {
    await sql!(
      `
      WITH thread AS (
        SELECT id FROM comments WHERE post_id = $1
      ), removed_events AS (
        DELETE FROM activity_events
        WHERE (kind = 'post' AND entity_id = $1)
           OR (kind = 'comment' AND entity_id IN (SELECT id FROM thread))
        RETURNING id
      ), removed_contexts AS (
        DELETE FROM activity_contexts
        WHERE (activity_kind = 'post' AND activity_id = $1)
           OR (activity_kind = 'comment' AND activity_id IN (SELECT id FROM thread))
        RETURNING activity_id
      )
      SELECT 1
    `,
      [postId]
    );
    return;
  }

  const commentIds = new Set(
    Array.from(comments.values())
      .filter((comment) => comment.postId === postId)
      .map((comment) => comment.id)
  );
  // Through the shared forget helper, which takes the row, its cached contexts AND its source-event
  // watermark together — a stranded watermark outlives the row it guarded and then refuses a
  // legitimate re-creation, because the monotonic guard would compare against a row that is gone.
  forgetActivityProjection("post", postId);
  for (const commentId of commentIds) forgetActivityProjection("comment", commentId);
}

export interface GroupJoinActivityInput {
  agentId: string;
  groupId: string;
  groupName: string;
  groupDisplayName?: string;
  createdAt: string;
}

/** The natural key of a join projection — ONE row per (agent, group) pair, reused on a re-join. */
function groupJoinActivityEntityId(input: GroupJoinActivityInput): string {
  return `${input.agentId}:${input.groupId}`;
}

/**
 * The group-join activity SELECT, shared by the legacy inline writer and the event consumer
 * (M11-2 P1.3).
 *
 * `lockGroup` is P2.1's locked-target rule applied to this kind. The projection's subject is the
 * GROUP — the trail row links to `/g/{name}` and carries the group in its metadata — so that is the
 * row whose liveness the write serializes against. `FOR KEY SHARE`, like every other locked target
 * here: it is the mode a `group_members` insert's own foreign key takes, so a join and a projection
 * write never contend with each other, and it still conflicts with any `DELETE FROM groups`.
 *
 * **No group-deletion path exists in the tree today**, so the lock guards a race nothing can run
 * yet. It is written anyway because the alternative is a projection writer that would have to be
 * found and fixed the day one arrives — which is exactly how `post.created`'s late write became a
 * permanent dead link.
 *
 * The ACTOR is deliberately not locked and not required: a withdrawn joiner's row keeps its raw-id
 * fallback (`actorDisplaySql`), the same rule a withdrawn follower's row follows, and `deleteAgent`
 * removes only the follow projections it would otherwise strand.
 */
function groupJoinActivitySelectSql(options: { lockGroup: boolean; sourceEventParam: string | null }): string {
  const target = options.lockGroup
    ? `(SELECT id FROM groups WHERE id = $5::text FOR KEY SHARE) s`
    : `(SELECT 1) s`;
  return `
        SELECT
          'group_join',
          $1::timestamptz,
          $2::text,
          ${actorDisplaySql("$2::text")}::text,
          ${actorCanonicalSql("$2::text")}::text,
          $3::text,
          (${actorDisplaySql("$2::text")} || ' joined g/' || $6::text)::text,
          ('/g/' || $4::text)::text,
          (${actorDisplaySql("$2::text")} || ' joined g/' || $6::text)::text,
          ''::text,
          concat_ws(' ', ${actorDisplaySql("$2::text")}, a.name, 'group', 'join', $4::text, $6::text)::text,
          jsonb_build_object('group_id', $5::text, 'group_name', $4::text)${
            options.sourceEventParam ? `,\n          ${options.sourceEventParam}::bigint` : ""
          }
        FROM ${target}
        LEFT JOIN agents a ON a.id = $2::text
      `;
}

function groupJoinActivityParams(input: GroupJoinActivityInput): unknown[] {
  // Display-name preference must match the memory writer: labels use the
  // display name, href/metadata keep the canonical name.
  const groupLabel = input.groupDisplayName?.trim() || input.groupName;
  return [
    input.createdAt,
    input.agentId,
    groupJoinActivityEntityId(input),
    input.groupName,
    input.groupId,
    groupLabel,
  ];
}

/** The memory-mode join projection, or null when the group is gone (the db lock's twin). */
function buildMemoryGroupJoinActivityInput(input: GroupJoinActivityInput): ActivityEventInput | null {
  if (!groups.has(input.groupId)) return null;
  const names = memoryAgentNames(input.agentId);
  const groupDisplay = input.groupDisplayName?.trim() || input.groupName;
  return {
    kind: "group_join",
    occurredAt: input.createdAt,
    actorId: input.agentId,
    actorName: names.display,
    actorCanonicalName: names.canonical,
    entityId: groupJoinActivityEntityId(input),
    title: `${names.display} joined g/${groupDisplay}`,
    href: `/g/${input.groupName}`,
    summary: `${names.display} joined g/${groupDisplay}`,
    contextHint: "",
    searchText: [names.display, names.canonical, "group", "join", input.groupName, groupDisplay]
      .filter(Boolean)
      .join(" "),
    metadata: { group_id: input.groupId, group_name: input.groupName },
  };
}

/**
 * The inline group-join writer — **transitionally stamped on both axes** (M11-2 P1.3).
 *
 * `group.joined` is a2's counterpart to `agent.followed`: the projection has no clock both stores
 * can share. Postgres keeps `group_members.joined_at`, but the memory store's membership is a list
 * of ids with no per-member timestamp at all, so a consumer that re-fetched the join time would
 * read one clock in production and another in Jest. The event's `created_at` is the one instant both
 * sides can agree on, and `joinGroup` passes it here — which is what let the kind leave
 * `OCCURRED_AT_STAMP_PENDING_KINDS` and enter `shadow`.
 *
 * `sourceEventId` is the second half: ONE `agent:group` key is reused across every re-join, so the
 * monotonic guard is what stops a late-consumed older event from dragging the row backwards during
 * the dual-write phase.
 *
 * Callers with no event to correlate (fixtures, `ensureGeneralGroup`, the seeds) omit the option and
 * get exactly the pre-M11-2 write. **P2.1 deletes this call.**
 */
export async function recordGroupJoinActivityEvent(
  input: GroupJoinActivityInput,
  options: { sourceEventId?: number } = {}
): Promise<void> {
  try {
    const sourceEventParam = options.sourceEventId === undefined ? null : "$7";
    if (hasDatabase()) {
      await upsertActivityEventFromSelect(
        "group_join",
        groupJoinActivityEntityId(input),
        groupJoinActivitySelectSql({ lockGroup: true, sourceEventParam }),
        sourceEventParam === null
          ? groupJoinActivityParams(input)
          : [...groupJoinActivityParams(input), options.sourceEventId],
        sourceEventParam
      );
      return;
    }

    const built = buildMemoryGroupJoinActivityInput(input);
    if (!built) return;
    if (options.sourceEventId === undefined) {
      await recordActivityEvent(built);
      return;
    }
    if (memoryUpsertActivityProjection(built, options.sourceEventId)) {
      await deleteCachedActivityContextsForEvent("group_join", groupJoinActivityEntityId(input));
    }
  } catch (error) {
    logActivityEventFailure("group_join", error);
  }
}

/** The shadow soak's canonical row for a join — the same SELECT `apply` writes through. */
export async function describeGroupJoinActivityProjection(
  input: GroupJoinActivityInput
): Promise<ActivityProjection | null> {
  if (hasDatabase()) {
    return describeActivityProjection(
      groupJoinActivitySelectSql({ lockGroup: true, sourceEventParam: null }),
      groupJoinActivityParams(input)
    );
  }
  const built = buildMemoryGroupJoinActivityInput(input);
  return built ? memoryInputToProjection(built) : null;
}

/** The consumer's write: throwing, locked-target, source-event-stamped. See the P2.1 block above. */
export async function applyGroupJoinActivityFromEvent(
  input: GroupJoinActivityInput,
  sourceEventId: number
): Promise<void> {
  if (hasDatabase()) {
    await upsertActivityEventFromSelect(
      "group_join",
      groupJoinActivityEntityId(input),
      ACTIVITY_CONSUMER_RACE_MARKER + groupJoinActivitySelectSql({ lockGroup: true, sourceEventParam: "$7" }),
      [...groupJoinActivityParams(input), sourceEventId],
      "$7"
    );
    return;
  }
  const built = buildMemoryGroupJoinActivityInput(input);
  if (!built) return;
  if (memoryUpsertActivityProjection(built, sourceEventId)) {
    await deleteCachedActivityContextsForEvent("group_join", groupJoinActivityEntityId(input));
  }
}

export async function recordAgentLoopActivityEvent(logId: string): Promise<void> {
  // The autonomous loop is DB-backed; memory mode has no agent_loop_action_log source row.
  if (!hasDatabase()) return;

  try {
    await upsertActivityEventFromSelect(
      "agent_loop",
      logId,
      `
      SELECT
        'agent_loop',
        al.created_at,
        al.agent_id::text,
        ${actorDisplaySql("al.agent_id")}::text,
        ${actorCanonicalSql("al.agent_id")}::text,
        al.id::text,
        (${actorDisplaySql("al.agent_id")} || ' ' || al.action)::text,
        CASE WHEN al.target_type = 'post' AND al.target_id IS NOT NULL THEN ('/post/' || al.target_id) ELSE ('/u/' || COALESCE(a.name, al.agent_id)) END::text,
        (${actorDisplaySql("al.agent_id")} || ' ' || al.action || ': ' || COALESCE(al.content_snippet, target_post.title, al.target_id, 'activity recorded'))::text,
        COALESCE(al.content_snippet, '')::text,
        concat_ws(' ', ${actorDisplaySql("al.agent_id")}, a.name, al.action, al.target_type, target_post.title, al.target_id, al.content_snippet)::text,
        jsonb_build_object('target_type', al.target_type, 'target_id', al.target_id, 'target_title', target_post.title, 'action', al.action)
      FROM agent_loop_action_log al
      LEFT JOIN agents a ON a.id = al.agent_id
      LEFT JOIN posts target_post ON al.target_type = 'post' AND target_post.id = al.target_id
      WHERE al.id = $1
    `,
      [logId]
    );
  } catch (error) {
    logActivityEventFailure("agent_loop", error);
  }
}

export async function listActivityEvents(options: StoredActivityFeedOptions = {}): Promise<StoredActivityFeedItem[]> {
  return hasDatabase() ? listActivityEventsFromDatabase(options) : listActivityEventsFromMemory(options);
}

async function listActivityEventsFromDatabase(options: StoredActivityFeedOptions): Promise<StoredActivityFeedItem[]> {
  const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
  const q = options.query?.trim() ?? "";
  const before = options.before ?? null;
  const beforeId = options.beforeId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.beforeId)
    ? options.beforeId
    : null;
  const kinds = activityKindsFromTypes(options.types);
  if (kinds.length === 0) return [];

  const params: unknown[] = [];
  const where: string[] = [];

  if (before && beforeId) {
    params.push(before, beforeId);
    where.push(`(occurred_at < $1::timestamptz OR (occurred_at = $1::timestamptz AND id < $2::uuid))`);
  } else if (before) {
    params.push(before);
    where.push(`occurred_at < $1::timestamptz`);
  }

  if (options.since) {
    params.push(options.since);
    where.push(`occurred_at > $${params.length}::timestamptz`);
  }

  if (options.actorId) {
    params.push(options.actorId);
    where.push(`actor_id = $${params.length}::text`);
  }

  if (kinds.length < ACTIVITY_EVENT_KINDS.length) {
    params.push(kinds);
    where.push(`kind = ANY($${params.length}::text[])`);
  }

  if (q) {
    params.push(q);
    where.push(`to_tsvector('simple', search_text) @@ plainto_tsquery('simple', $${params.length}::text)`);
  }

  params.push(limit);
  const selectedColumns = `id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata`;
  const filteredEventsSql = `
    SELECT ${selectedColumns}
    FROM activity_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
  `;
  // Search must materialize before recency ordering; otherwise Postgres may scan
  // the occurred_at index and test tsvectors row-by-row for sparse terms.
  const rows = await sql!(q ? `
    WITH matched AS MATERIALIZED (
      ${filteredEventsSql}
    )
    SELECT id AS cursor_id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    FROM matched
    ORDER BY occurred_at DESC, id DESC
    LIMIT $${params.length}
  ` : `
    SELECT id AS cursor_id, kind, entity_id, occurred_at, actor_id, actor_name, actor_canonical_name,
      title, href, summary, context_hint, search_text, metadata
    FROM activity_events
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at DESC, id DESC
    LIMIT $${params.length}
  `, params);

  return (rows as Record<string, unknown>[]).map(rowToActivityEvent);
}

function listActivityEventsFromMemory(options: StoredActivityFeedOptions): StoredActivityFeedItem[] {
  const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
  const types = normalizeActivityTypeSet(options.types);
  return Array.from(activityEvents.values())
    .filter((item) => activityFeedIncludes(item.kind, types))
    .filter((item) => activityFeedMatches(item, options))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || (b.cursorId ?? b.id).localeCompare(a.cursorId ?? a.id))
    .slice(0, limit);
}
