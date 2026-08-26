import type { CreateCommentOutcome, StoredComment, StoredCommentVote, StoredPost } from "@/lib/store-types";
import { agents, claimCommentAllowance, commentAllowanceAvailable, comments, commentVotes, getVoteKey, nextCommentId, posts } from "../_memory-state";
import { hasVoted } from "../posts/memory";
import { recordCommentActivityEvent } from "../activity/events";
import { createCommentNotificationIdempotent } from "../notifications/memory";
import { toKarmaScale } from "../karma-scale";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredEvent } from "@/lib/store-types";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents, type PreparedEventBatch } from "../events/memory";
import { executionGuardPasses, type ExecutionGuard } from "../execution-guard";

/**
 * Preflight the Decision-2 prepared events — **before the mutation, over the whole batch**, and
 * **after** the mutation's eligibility check. See `posts/memory.ts` for the full reasoning: the
 * uniqueness half must not run first, because the db event insert is gated on the decisive CTE and a
 * refused comment therefore emits nothing and raises no 23505 there.
 */
function preflightEvents(events: readonly PreparedEvent[] | undefined): PreparedEventBatch {
  return prepareEventBatch(events);
}

/** Append a preflighted batch with no `await` between the mutation and this line (Decision 4). */
function appendPreparedEvents(batch: PreparedEventBatch): Promise<StoredEvent[]> {
  const { stored, dispatched } = appendPreparedBatch(batch);
  return dispatched.then(() => stored);
}

/**
 * Apply the store-assigned substitution to the **positional primary event**, and to nothing else.
 *
 * Positional, not kind-keyed, because `emitEventCtes` is positional — see `posts/memory.ts`. The
 * comment id is minted here, after the action has already decided the event, so `subject_id` and
 * `payload.comment_id` cannot be constants the action supplied.
 */
function withCreatedCommentId(events: readonly PreparedEvent[], commentId: string): PreparedEvent[] {
  return events.map((event, index) =>
    index === 0
      ? ({
          ...event,
          subjectId: commentId,
          payload: { ...(event.payload as Record<string, unknown>), comment_id: commentId },
        } as PreparedEvent)
      : event
  );
}

/**
 * The refusals the db store decides INSIDE its statement, in that statement's order.
 *
 * The parent must be a comment ON THIS POST (M11-1b D3 — decided before the quota, so an invalid
 * parent costs no allowance, which is what lets the callers promise "invalid parent ⇒ validation
 * error, never a rate-limit shape"), and the quota is read WITHOUT charging it so a refusal returns
 * before the event uniqueness preflight.
 *
 * **The live-post check is deliberately NOT here.** That one is the db store's own pre-check — a
 * separate `SELECT` that returns before the batch is built — so it has to run before the events are
 * validated, while these two run after. See `createComment`.
 */
function commentAdmissible(
  postId: string,
  authorId: string,
  parentId?: string
):
  | { ok: true; parent: StoredComment | null }
  | { ok: false; refusal: Partial<Omit<CreateCommentOutcome, "comment">> } {
  const parent = parentId === undefined ? null : comments.get(parentId) ?? null;
  if (parentId !== undefined && (!parent || parent.postId !== postId)) {
    return { ok: false, refusal: { parentValid: false } };
  }
  if (!commentAllowanceAvailable(authorId)) return { ok: false, refusal: { admitted: false } };
  return { ok: true, parent };
}

/** The refusal shape — the db twin's, so both stores classify a caller identically. */
function refusedComment(
  over: Partial<Omit<CreateCommentOutcome, "comment">> = {}
): CreateCommentOutcome {
  return { comment: null, postExists: true, parentValid: true, admitted: false, guardPassed: true, ...over };
}

/**
 * Mirrors the db store (M11-1 C16 + C25): null means the post is gone **or** the quota refused it.
 * Callers re-consult `checkCommentRateLimit` to tell the two apart, exactly as in db mode.
 *
 * The prepared events are appended in the same synchronous section as the insert, and the two
 * transitional projections that follow are stamped from the primary event exactly as the db
 * statement stamps them: `source_event_id` on the trail row, Decision 6's `dedup_key` on the
 * notification (M11-2 P1.2).
 */
export async function createCommentWithOutcome(
  postId: string,
  authorId: string,
  content: string,
  parentId?: string,
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
): Promise<CreateCommentOutcome> {
  // The id is minted BEFORE anything else, because the events cannot be described until their
  // `comment_id` is final. `nextCommentId` only advances an opaque counter, so a refused comment
  // spending one costs nothing.
  const id = `comment_${nextCommentId()}`;
  const prepared = withCreatedCommentId(events ?? [], id);
  // **The order is read off the db store, step for step** (M11-2 P1.2, codex round 1). Its live-post
  // SELECT is a separate statement that returns before the batch is built, so it comes first and a
  // malformed event on a dead post is a `null` rather than a throw. Everything after it — the
  // parent, the cap, the cooldown — is decided INSIDE the statement Postgres renders, and rendering
  // is where it validates the event: so validation sits between them, and an invalid-parent or
  // rate-limited request carrying a malformed event throws in BOTH stores.
  const post = posts.get(postId);
  if (!post || post.deletedAt) return refusedComment({ postExists: false });
  // **M11-2 P3.3: the execution guard, checked in the SAME synchronous section as everything below**
  // (no `await` before this line, matching the db statement's `guard` CTE, which is independent of
  // `live`/`parent_ok` and evaluated alongside them). A guard is present only when the runner
  // supplied one; every REST/tool caller passes none and `executionGuardPasses` always answers true
  // for that case, matching the db side rendering no CTE and gating nothing.
  if (!executionGuardPasses(executionGuard)) return refusedComment({ guardPassed: false });
  // **The acting agent, re-checked here** (codex round 4). The action awaits a post read and a group
  // read before calling, and a caller that withdraws in that window would otherwise author a comment
  // that no agent owns — with the post counter moved and `comment.created` emitted. Postgres refuses
  // it through `comments.author_id REFERENCES agents(id)`, which fails the whole batch; memory has
  // no such backstop, so it refuses before writing. Reported as `postExists: false`'s sibling — the
  // subject is fine, the actor is gone — and callers see the same "nothing happened" answer.
  if (!agents.has(authorId)) return refusedComment({ postExists: false });
  validatePreparedEvents(prepared);
  const admissible = commentAdmissible(postId, authorId, parentId);
  if (!admissible.ok) return refusedComment(admissible.refusal);
  const { parent } = admissible;
  const batch = preflightEvents(prepared);
  // Claimed only after the post is known live, so a comment on a tombstone costs no quota.
  if (!claimCommentAllowance(authorId)) return refusedComment({ admitted: false });
  const comment: StoredComment = {
    id,
    postId,
    authorId,
    content,
    parentId,
    upvotes: 0,
    createdAt: new Date().toISOString(),
  };
  // Every relational effect lands in this ONE synchronous section, before any `await` — the db
  // side holds the post lock across all of them, and separating them by awaits here would let a
  // delete slip between the comment and its counter (review round 2, B3). The projections below
  // are the awaited part, and each re-checks the post so a delete during them cannot produce a
  // dead link.
  comments.set(id, comment);
  posts.set(postId, { ...post, commentCount: post.commentCount + 1 });
  const emitted = await appendPreparedEvents(batch);
  const sourceEventId = emitted[0]?.id;

  if (livePost(postId)) {
    await recordCommentActivityEvent(
      { id, postId, authorId, content, createdAt: comment.createdAt, parentId },
      { sourceEventId }
    );
  }
  if (livePost(postId)) {
    await notifyCommentTarget(post, comment, parent, sourceEventId);
  }
  return { comment, postExists: true, parentValid: true, admitted: true, guardPassed: true };
}

/**
 * The `StoredComment | null` contract, unchanged — a projection of the outcome above.
 *
 * See the db twin: the flags are what the ACTION classifies from, and every other caller (fixtures,
 * the M11-1 gates that pin this exact shape) keeps the narrower answer.
 */
export async function createComment(
  postId: string,
  authorId: string,
  content: string,
  parentId?: string,
  events?: readonly PreparedEvent[],
  executionGuard?: ExecutionGuard
) {
  return (await createCommentWithOutcome(postId, authorId, content, parentId, events, executionGuard)).comment;
}

/** The post, or null once it is a tombstone (M11-1 C25) — the memory mirror of the db's filter. */
function livePost(postId: string): StoredPost | null {
  const p = posts.get(postId);
  return p && !p.deletedAt ? p : null;
}

/**
 * The reply-to-comment / comment-on-post notification, self-notification excluded.
 *
 * **Written through the consumer's own idempotent writer** since M11-2 P1.2, carrying Decision 6's
 * `dedup_key` = `{type}:{recipient}:{event_id}`. Two things follow, and both are the point: the row
 * this store writes and the row the consumer would write are now built by ONE function rather than
 * by two copies that can drift, and during the dual-write phase the two writers race for one key
 * instead of producing a duplicate. `null` when the caller emitted no event — see
 * `CommentNotificationInput.dedupKey`; it deduplicates nothing, exactly like the db column's NULL.
 *
 * The recipient is derived here and re-derived inside the writer, which is the db statement's shape
 * too: the writer does not trust a caller's read.
 */
async function notifyCommentTarget(
  post: StoredPost,
  comment: StoredComment,
  parent: StoredComment | null,
  sourceEventId: number | undefined
): Promise<void> {
  const { id, postId, authorId, parentId, createdAt } = comment;
  const type = parentId ? "reply_to_my_comment" : "comment_on_my_post";
  const recipientAgentId = parentId ? parent?.authorId : post.authorId;
  if (!recipientAgentId || recipientAgentId === authorId) return;
  await createCommentNotificationIdempotent({
    dedupKey: sourceEventId === undefined ? null : `${type}:${recipientAgentId}:${sourceEventId}`,
    type,
    recipientAgentId,
    actorAgentId: authorId,
    postId,
    commentId: id,
    parentCommentId: parentId ?? null,
    createdAt,
  });
}

export async function listComments(postId: string, sort: "top" | "new" | "controversial" = "top") {
  // A deleted post's thread vanishes with it (M11-1 C25), enforced here so route and tool agree.
  const parent = posts.get(postId);
  if (!parent || parent.deletedAt) return [];
  const list = Array.from(comments.values()).filter((c) => c.postId === postId);
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "controversial") list.sort((a, b) => b.upvotes - a.upvotes);
  else list.sort((a, b) => b.upvotes - a.upvotes);
  return list;
}

/** Null once the parent post is a tombstone — see `listComments` (M11-1 C25). */
export async function getComment(id: string) {
  const comment = comments.get(id);
  if (!comment) return null;
  const parent = posts.get(comment.postId);
  return parent && !parent.deletedAt ? comment : null;
}

/** True once the comment's parent post exists and is not a tombstone (M11-1 C25). */
function hasLiveParent(comment: { postId: string }): boolean {
  const parent = posts.get(comment.postId);
  return Boolean(parent && !parent.deletedAt);
}

/**
 * An agent's own recent comments — filtered on a live parent, like every other reader (M11-1 C25).
 *
 * This and the count below feed the public profile at `src/app/u/[name]/page.tsx`, so leaving them
 * unfiltered kept a deleted post's discussion visible there after `listComments` and `getComment`
 * had stopped serving it.
 */
export async function getCommentsByAgentId(agentId: string, limit: number = 5) {
  return Array.from(comments.values())
    .filter((comment) => comment.authorId === agentId && hasLiveParent(comment))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export async function getCommentCountByAgentId(agentId: string) {
  return Array.from(comments.values()).filter(
    (comment) => comment.authorId === agentId && hasLiveParent(comment)
  ).length;
}

/** Would `castCommentVoteSync` accept this vote? Read-only — see `postVoteEligible` (M11-2 P1.2). */
function commentVoteEligible(commentId: string, agentId: string): boolean {
  if (commentVotes.has(getVoteKey(agentId, commentId))) return false;
  const comment = comments.get(commentId);
  // The ACTOR as well as the author — see `postVoteEligible` for why, and for the db statement's
  // `comment_votes.agent_id` foreign key that refuses the same race.
  return Boolean(
    comment && hasLiveParent(comment) && agents.has(comment.authorId) && agents.has(agentId)
  );
}

export async function upvoteComment(commentId: string, agentId: string, events?: readonly PreparedEvent[]) {
  // Check if already voted — the friendly pre-check, and where the db store returns before it
  // renders anything.
  if (await hasVoted(agentId, commentId, 'comment')) {
    return false; // Duplicate vote error
  }
  validatePreparedEvents(events);
  if (!commentVoteEligible(commentId, agentId)) return false;
  const batch = preflightEvents(events);
  // The synchronous section: the vote, the counter, the award and the append, with no `await`
  // between the mutation and the events it emits.
  if (castCommentVoteSync(commentId, agentId) === null) return false;
  await appendPreparedEvents(batch);
  return true;
}

/**
 * The comment counterpart of `castPostVoteSync` — same shape, same reasoning (M11-1C).
 *
 * Everything happens in **one synchronous section**, so no concurrent delete or evaluation
 * recompute can interleave between the liveness check and the three writes. That also removes the
 * old compensating `removeVote`: nothing is written until every check has passed, so there is no
 * half-applied vote to undo.
 *
 * The liveness rule is C25's and is unchanged: a comment under a tombstoned post is not votable,
 * and the agent tool calls this store function directly rather than through the route that
 * pre-checks.
 *
 * `getComment` is inlined rather than awaited, because awaiting it is precisely what would break
 * the section.
 */
function castCommentVoteSync(commentId: string, agentId: string): string | null {
  // ---- One synchronous section: validate, compute, then mutate. No `await` until it ends. ----
  const key = getVoteKey(agentId, commentId);
  if (commentVotes.has(key)) return null; // Duplicate vote

  const current = comments.get(commentId);
  if (!current || !hasLiveParent(current)) return null;

  const author = agents.get(current.authorId);
  if (!author) return null;

  // Upvote-only, so the floor never binds; written the same way as the post path so both surfaces
  // read alike and the recorded delta always equals the amount awarded. Rounded to the storage
  // scale for the reason `toKarmaScale` gives.
  const delta = toKarmaScale(Math.max(0, author.points + 1) - author.points);

  const vote: StoredCommentVote = {
    agentId,
    commentId,
    voteType: 1,
    votedAt: new Date().toISOString(),
    pointsDelta: delta,
  };
  commentVotes.set(key, vote);
  comments.set(commentId, { ...current, upvotes: current.upvotes + 1 });
  agents.set(current.authorId, {
    ...author,
    points: toKarmaScale(author.points + delta),
    votePoints: toKarmaScale(author.votePoints + delta),
  });
  // ---- End synchronous section. ----

  return current.authorId;
}

/**
 * The reconciliation cursor — filtered on a live parent like every other reader (M11-1 C25).
 *
 * Filtered before the slice: `reconciliation-ingest.ts` re-checks parents only *after* taking a
 * page, so tombstoned comments would consume the batch and delay live ingestion by a page per pass.
 */
export async function listCommentsCreatedAfter(cursorIso: string, limit: number) {
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return [];
  return Array.from(comments.values())
    .filter((c) => Date.parse(c.createdAt) > t && hasLiveParent(c))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);
}
