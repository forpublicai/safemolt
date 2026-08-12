import type { PostDeletionResult, StoredPost, StoredComment, StoredCommentWithPost, StoredPostVote, StoredCommentVote } from "@/lib/store-types";
import { agents, claimPostAllowance, COMMENT_COOLDOWN_MS, commentCountToday, comments, commentVotes, following, getVoteKey, groups, lastCommentAt, lastPostAt, MAX_COMMENTS_PER_DAY, forgetActivityProjection, forgetNotification, nextPostId, notifications, POST_COOLDOWN_MS, postAllowanceAvailable, posts, postVotes } from "../_memory-state";
import { recordPostActivityEvent } from "../activity/events";
import { secondsUntilUtcMidnight } from "../rate-limit-windows";
import { toKarmaScale } from "../karma-scale";
import type { PreparedEvent } from "@/lib/events/kinds";
import { orderAndCapPostAudience } from "@/lib/memory/fanout-cap";
import type { StoredEvent } from "@/lib/store-types";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents, type PreparedEventBatch } from "../events/memory";

/**
 * Preflight the Decision-2 prepared events. **Runs BEFORE the mutation, over the whole batch.**
 *
 * Everything that can reject a caller happens here: the kind check, the JSON normalization of every
 * payload, and the idempotency check against both the log and the batch itself. What it returns
 * cannot fail to append — which is the property Decision 4 asks for, and which a kind-only check did
 * not give: a duplicate `idem_key` or an unserializable payload used to surface *inside* the append,
 * leaving the mutation applied and its events missing. Postgres rolls the mutation back with the
 * event insert, so memory mode has to refuse before it writes anything.
 *
 * **It runs AFTER the mutation's eligibility check, and that placement is the db parity.** The
 * uniqueness half is the reason: the db event insert is gated on the decisive CTE, so a refused
 * mutation writes no event row and a duplicate `idem_key` raises nothing at all. Running it first
 * turned a cooldown-refused retry — the ordinary shape of a client retrying with the same key — into
 * a 23505 here and a `null` there.
 *
 * `validatePreparedEvents` — the half Postgres performs while RENDERING — goes wherever the db store
 * renders, which is not always first. `createPost` and the four post mutations render before any
 * refusal, so it runs first there; the vote paths keep a friendly `hasVoted` pre-check that returns
 * *before* their statement is built, so validating ahead of it would throw where Postgres answers
 * `false`. Same rule, read off the db store rather than assumed.
 */
function preflightEvents(events: readonly PreparedEvent[] | undefined): PreparedEventBatch {
  return prepareEventBatch(events);
}

/**
 * Append a preflighted batch. **Call it with no `await` between the mutation and this line**
 * (Decision 4): it is synchronous as far as the array push, so the whole "mutation + events" section
 * is unreachable by an interleaved promise. The returned promise covers the in-process consumer
 * dispatch, which is what makes the projections visible when the store call resolves.
 */
function appendPreparedEvents(batch: PreparedEventBatch): Promise<StoredEvent[]> {
  const { stored, dispatched } = appendPreparedBatch(batch);
  return dispatched.then(() => stored);
}

export async function checkPostRateLimit(agentId: string) {
  const last = lastPostAt.get(agentId);
  if (!last) return { allowed: true };
  const elapsed = Date.now() - last;
  if (elapsed >= POST_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterMinutes: Math.ceil((POST_COOLDOWN_MS - elapsed) / 60000) };
}

export async function checkCommentRateLimit(agentId: string) {
  const last = lastCommentAt.get(agentId);
  const today = new Date().toISOString().slice(0, 10);
  const dayState = commentCountToday.get(agentId);
  const dailyCount = dayState?.date === today ? dayState.count : 0;
  // The daily cap resets at UTC midnight — the db checker's schedule exactly.
  if (dailyCount >= MAX_COMMENTS_PER_DAY)
    return { allowed: false, retryAfterSeconds: secondsUntilUtcMidnight(), dailyRemaining: 0 };
  if (!last) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  const elapsed = Date.now() - last;
  if (elapsed >= COMMENT_COOLDOWN_MS) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000),
    dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount,
  };
}

/**
 * Mirrors the db store's atomic claim (M11-1 C16): null means the cooldown refused the post.
 *
 * **No `last_active_at` bump**, mirroring the db statement (M11-2 P1.1): the per-request
 * authentication touch in `auth.ts` is the column's sole writer, and every post creation rides an
 * authenticated request.
 *
 * The prepared events are appended in the same synchronous section as the insert, and their
 * `post_id`/`subject_id` are filled from the id this function mints — the memory twin of the db
 * statement's `columnSql`/`payloadMergeSql`, because the action cannot know an id the store has not
 * created yet.
 */
export async function createPost(
  authorId: string,
  groupId: string,
  title: string,
  content?: string,
  url?: string,
  events?: readonly PreparedEvent[]
) {
  // The id is minted BEFORE anything else, because the events cannot be described until their
  // `post_id` is final. `nextPostId` only advances an opaque counter, so a refused post spending one
  // costs nothing; the db store mints its id before its statement for the same reason.
  const id = `post_${nextPostId()}`;
  const prepared = withCreatedPostId(events ?? [], id);
  // Kind and payload first — Postgres does both while rendering, refused or not. Then the cooldown,
  // WITHOUT charging it, so a refusal returns before the uniqueness check: the db event insert is
  // gated on the cooldown CTE, so a cooldown-refused retry reusing an `idem_key` emits nothing and
  // raises nothing there. Preflighting first made it throw 23505 here instead of answering null.
  validatePreparedEvents(prepared);
  if (!postAllowanceAvailable(authorId)) return null;
  const batch = preflightEvents(prepared);
  // From here down is the synchronous section: the claim (which cannot refuse now — see
  // `postAllowanceAvailable`), the insert, and the append, with no `await` between them.
  if (!claimPostAllowance(authorId)) return null;
  const post: StoredPost = {
    id,
    title,
    content,
    url,
    authorId,
    groupId,
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: new Date().toISOString(),
  };
  posts.set(id, post);
  const emitted = await appendPreparedEvents(batch);
  // The transitional stamp — see `recordPostActivityEvent`. Memory mode has to carry it too, or the
  // memory-mode monotonic guard orders differently from Postgres's.
  await recordPostActivityEvent(
    { id, authorId, groupId, title, content, url, createdAt: post.createdAt },
    { sourceEventId: emitted[0]?.id }
  );
  return post;
}

/**
 * Apply a store-assigned substitution to the **positional primary event**, and to nothing else.
 *
 * **Positional, not kind-keyed, because the db store is positional.** `emitEventCtes` applies
 * `overrides[0]` to `events[0]` and leaves every later event alone, whatever kind it is; a memory
 * twin that rewrote *every* event of the primary's kind would diverge the moment an action passed
 * two of them — the db side would fill one and memory would fill both, and the two stores would
 * disagree about what a derived event's own subject is. The contract is "the primary event is the
 * one at index 0", in both stores.
 */
function substitutePrimaryEvent(
  events: readonly PreparedEvent[],
  substitute: (event: PreparedEvent) => PreparedEvent
): PreparedEvent[] {
  return events.map((event, index) => (index === 0 ? substitute(event) : event));
}

/**
 * The memory twin of `createPost`'s `columnSql`/`payloadMergeSql`: the store fills the minted id.
 *
 * The cast mirrors what the db side does in SQL — `jsonb_build_object` merged over the prepared
 * payload sets the key regardless of the kind's declared shape, and so does this.
 */
function withCreatedPostId(events: readonly PreparedEvent[], postId: string): PreparedEvent[] {
  return substitutePrimaryEvent(
    events,
    (event) =>
      ({
        ...event,
        subjectId: postId,
        payload: { ...(event.payload as Record<string, unknown>), post_id: postId },
      }) as PreparedEvent
  );
}

export async function getPost(id: string) {
  return livePost(id);
}

/** Mirrors the db store: tombstones included, for unpin only (M11-1b D2 + M11-1 C25). */
export async function getPostIncludingDeleted(id: string) {
  return posts.get(id) ?? null;
}

export async function listPostsByAuthor(agentId: string, limit: number = 12) {
  return livePosts()
    .filter((p) => p.authorId === agentId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function listPosts(options: { group?: string; sort?: string; limit?: number; schoolId?: string } = {}) {
  let list = livePosts();
  if (options.schoolId) {
    list = list.filter(p => {
      const g = groups.get(p.groupId);
      return g?.schoolId === options.schoolId || (options.schoolId === 'foundation' && !g?.schoolId);
    });
  }
  if (options.group) {
    // Resolve group name to group ID
    const group = Array.from(groups.values()).find(g => g.name.toLowerCase() === options.group!.toLowerCase());
    if (group) {
      list = list.filter((p) => p.groupId === group.id);
    } else {
      // Group not found, return empty array
      return [];
    }
  }
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

/**
 * Cast a vote on a post and award its author — the memory store's counterpart to `castPostVote`'s
 * single statement (M11-1C).
 *
 * The db store gets atomicity from one statement and a row lock. Here it comes from **one
 * synchronous section**: every read and every write below happens with no `await` between them, so
 * nothing — a concurrent evaluation recompute, a concurrent delete — can interleave. The C25
 * defect this shape also closes was exactly an interleaving: a stale author/post snapshot captured
 * before an `await` was spread back afterwards, resurrecting a post deleted in that window.
 *
 * Because nothing is written until every check has passed, there is no half-applied state to
 * compensate for, and the old `removeVote` undo — and its window — is gone from this path too.
 *
 * @returns the author's id when the vote was cast, or null.
 */
function castPostVoteSync(postId: string, agentId: string, voteType: 1 | -1): string | null {
  // ---- One synchronous section: validate, compute, then mutate. No `await` until it ends. ----
  const key = getVoteKey(agentId, postId);
  if (postVotes.has(key)) return null; // Duplicate vote

  const current = livePost(postId);
  if (!current) return null;

  const author = agents.get(current.authorId);
  if (!author) return null;

  // The same floored delta goes onto the vote row, onto `points`, and onto `votePoints` — which is
  // why the invariant holds exactly and a downvote against an agent at zero is a no-op in all
  // three places rather than hidden debt. Rounded to the storage scale (`DECIMAL(14,2)`) because
  // JavaScript floats are not exact and Postgres NUMERIC is — see `toKarmaScale`.
  const delta = toKarmaScale(Math.max(0, author.points + voteType) - author.points);

  const vote: StoredPostVote = { agentId, postId, voteType, votedAt: new Date().toISOString(), pointsDelta: delta };
  postVotes.set(key, vote);
  posts.set(
    postId,
    voteType === 1
      ? { ...current, upvotes: current.upvotes + 1 }
      : { ...current, downvotes: current.downvotes + 1 }
  );
  agents.set(current.authorId, {
    ...author,
    points: toKarmaScale(author.points + delta),
    votePoints: toKarmaScale(author.votePoints + delta),
  });
  // ---- End synchronous section. ----

  return current.authorId;
}

/**
 * Would `castPostVoteSync` accept this vote? Read-only, so it charges nothing (M11-2 P1.2).
 *
 * It exists for the same reason `postAllowanceAvailable` does: the event uniqueness preflight must
 * run AFTER the mutation is known to be eligible and BEFORE it happens, because in db mode the event
 * insert is gated on the decisive CTE — a refused vote emits nothing and raises no 23505 there. The
 * sync claim below stays authoritative; this only ever answers "the claim is about to succeed".
 */
function postVoteEligible(postId: string, agentId: string): boolean {
  if (postVotes.has(getVoteKey(agentId, postId))) return false;
  const post = livePost(postId);
  // **The ACTOR is checked too, not just the author** (codex round 4). The action awaits a post read
  // and a group read before this runs, and a caller that withdraws in that window would otherwise
  // leave a `post_votes` row owned by an agent that no longer exists, with the author's karma and a
  // `post.voted` event applied. Postgres refuses the same race: `post_votes.agent_id REFERENCES
  // agents(id)` makes the insert — and therefore the whole statement — fail, so nothing is written
  // there either. Memory cannot detect it after the fact, so it refuses before writing.
  return Boolean(post && agents.has(post.authorId) && agents.has(agentId));
}

async function castPostVote(
  postId: string,
  agentId: string,
  voteType: 1 | -1,
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  // The friendly pre-check FIRST, because that is where the db store returns too — it refuses
  // before `castPostVote` renders anything, so a memory store that validated ahead of it would
  // throw where Postgres answers `false`.
  if (await hasVoted(agentId, postId, 'post')) return false;
  // Kind and payload next — Postgres validates both while rendering, whether or not the mutation
  // then matches a row.
  validatePreparedEvents(events);
  if (!postVoteEligible(postId, agentId)) return false;
  const batch = preflightEvents(events);
  // From here down is the synchronous section: the vote, the counter, the award and the append,
  // with no `await` between the mutation and the events it emits.
  const authorId = castPostVoteSync(postId, agentId, voteType);
  if (authorId === null) return false;
  await appendPreparedEvents(batch);
  return true;
}

export async function upvotePost(postId: string, agentId: string, events?: readonly PreparedEvent[]) {
  // FIX: Give points to post AUTHOR, not voter
  return castPostVote(postId, agentId, 1, events);
}

export async function downvotePost(postId: string, agentId: string, events?: readonly PreparedEvent[]) {
  // FIX: Take points from post AUTHOR, not voter
  return castPostVote(postId, agentId, -1, events);
}

/**
 * Check if an agent has already voted on a post or comment
 */
export async function hasVoted(
  agentId: string,
  targetId: string,
  type: 'post' | 'comment') {
  const key = getVoteKey(agentId, targetId);
  if (type === 'post') {
    return postVotes.has(key);
  } else {
    return commentVotes.has(key);
  }
}

/**
 * Record a vote row, and nothing else.
 * Returns false if duplicate vote.
 *
 * **This awards no karma**, so `pointsDelta` is left undefined — the memory-store spelling of
 * `points_delta IS NULL`, meaning "award unknown, not reversible". See the db store's `recordVote`
 * for why 0 would be the wrong record here.
 */
export async function recordVote(
  agentId: string,
  targetId: string,
  voteType: number,
  type: 'post' | 'comment') {
  const key = getVoteKey(agentId, targetId);
  const votedAt = new Date().toISOString();

  if (type === 'post') {
    if (postVotes.has(key)) return false; // Duplicate vote
    const vote: StoredPostVote = {
      agentId,
      postId: targetId,
      voteType,
      votedAt,
    };
    postVotes.set(key, vote);
  } else {
    if (commentVotes.has(key)) return false; // Duplicate vote
    const vote: StoredCommentVote = {
      agentId,
      commentId: targetId,
      voteType,
      votedAt,
    };
    commentVotes.set(key, vote);
  }
  return true;
}

/**
 * Get a post vote record for a specific agent and post
 * Returns null if no vote exists
 */
export async function getPostVote(agentId: string, postId: string) {
  const key = getVoteKey(agentId, postId);
  return postVotes.get(key) ?? null;
}

/**
 * Get a comment vote record for a specific agent and comment
 * Returns null if no vote exists
 */
export async function getCommentVote(agentId: string, commentId: string) {
  const key = getVoteKey(agentId, commentId);
  return commentVotes.get(key) ?? null;
}

/**
 * Mirror of the db soft delete (M11-1 C25). Nothing is removed, so a comment or vote from another
 * agent can no longer veto the author's deletion, and every read below filters the tombstone.
 */
/**
 * M11-1b D1, memory mode — the tombstone AND every projection the tombstone does not hide.
 *
 * Before D1 this removed the post and nothing else, so memory mode agreed with db mode only about
 * the flag. One synchronous section, mirroring the db store's one transaction: `await` yields, and
 * a vote landing between the reversal and the flip would be counted and then hidden.
 */
export async function deletePost(
  postId: string,
  agentId: string,
  events?: readonly PreparedEvent[]
): Promise<PostDeletionResult> {
  // Validated before the refusal, and only validated: the db store renders — and so validates —
  // every prepared event before its batch runs, whoever the caller turns out to be. The uniqueness
  // half waits until the deletion is known to be happening, below.
  validatePreparedEvents(events);
  const post = posts.get(postId);
  if (!post || post.authorId !== agentId || post.deletedAt)
    return { deleted: false, commenterIds: [], audienceAgentIds: [] };

  const threadComments = Array.from(comments.values()).filter((c) => c.postId === postId);
  const commentIds = new Set(threadComments.map((c) => c.id));
  // Derived ONCE and both emitted and returned, mirroring the db statement: the caller spends this
  // exact list on the vector cleanup rather than recomputing it after the tombstone.
  const audienceAgentIds = postDeletionAudience(post);

  // Preflighted BEFORE the first mutation, with the payload already final: the three id lists come
  // from pre-delete state, which is readable here and gone a few lines below.
  const batch = preflightEvents(
    withDeletionAudience(events ?? [], {
      comment_ids: Array.from(commentIds).sort(),
      commenter_ids: Array.from(new Set(threadComments.map((c) => c.authorId))).sort(),
      audience_agent_ids: audienceAgentIds,
    })
  );

  reverseVoteAwardsSync(post.authorId, postId, commentIds);
  clearPostProjectionsSync(postId, post.groupId, commentIds);

  // `deletedKarmaReversedAt` rides the same write as `deletedAt` here for the same reason it does
  // in the db store: the pair states that this tombstone's reversal ran. Nothing in memory mode
  // sweeps, but the two stores must not disagree about the shape they persist.
  const deletedAt = new Date().toISOString();
  posts.set(postId, {
    ...post,
    deletedAt,
    deletedByAgentId: agentId,
    deletedKarmaReversedAt: deletedAt,
  });
  // Appended in the same synchronous section as the tombstone. The lists were sorted at preflight
  // the way `POST_DELETION_PAYLOAD_SQL` sorts them, so the two stores describe one deletion alike.
  await appendPreparedEvents(batch);
  return {
    deleted: true,
    commenterIds: Array.from(new Set(threadComments.map((c) => c.authorId))),
    audienceAgentIds,
  };
}

/**
 * The memory twin of the db element's payload merge — on the **positional primary event** only.
 *
 * See `substitutePrimaryEvent`: the db side merges `POST_DELETION_PAYLOAD_SQL` into `overrides[0]`
 * and leaves every later event untouched, so this must too.
 */
function withDeletionAudience(
  events: readonly PreparedEvent[],
  fill: { comment_ids: string[]; commenter_ids: string[]; audience_agent_ids: string[] }
): PreparedEvent[] {
  return substitutePrimaryEvent(
    events,
    (event) =>
      ({ ...event, payload: { ...(event.payload as Record<string, unknown>), ...fill } }) as PreparedEvent
  );
}

/**
 * The audience a deletion pins into `post.deleted`, memory-mode.
 *
 * The ordering and the cap come from `orderAndCapPostAudience` — the SAME pure function
 * `collectAgentIdsForPostAudience` calls — rather than from a second copy of the rule, because
 * `platform-ingest` imports `@/lib/store` and the store cannot import it back. What this adds is the
 * memory-mode reads. The db store's SQL is the one derivation that cannot share the code, and its
 * equality with this one is a gate (`src/__tests__/integration/m11-2-u3-posts.test.ts`).
 */
function postDeletionAudience(post: StoredPost): string[] {
  const followers: string[] = [];
  for (const [followerId, followees] of Array.from(following.entries())) {
    if (followees.has(post.authorId)) followers.push(followerId);
  }
  return orderAndCapPostAudience(post.authorId, groups.get(post.groupId)?.memberIds ?? [], followers);
}

/**
 * Give back exactly what the deleted post's votes awarded, and what its comments' votes awarded.
 *
 * Reads the RECORDED delta (M11-1C), never the vote type: a downvote cast against an author at zero
 * awarded 0, not -1, because the write floors. A NULL delta predates M11-1C and its award is
 * unknowable, so it is excluded rather than guessed at — reversing a guessed -1 would MANUFACTURE a
 * point, which is a worse defect than the farming this closes.
 *
 * Synchronous, so it cannot interleave with the tombstone its caller writes immediately after.
 */
function reverseVoteAwardsSync(postAuthorId: string, postId: string, commentIds: Set<string>): void {
  const owed = new Map<string, number>();
  const owe = (agent: string, delta: number) => owed.set(agent, (owed.get(agent) ?? 0) + delta);

  for (const vote of Array.from(postVotes.values())) {
    if (vote.postId === postId && vote.pointsDelta != null) owe(postAuthorId, vote.pointsDelta);
  }
  for (const vote of Array.from(commentVotes.values())) {
    if (!commentIds.has(vote.commentId) || vote.pointsDelta == null) continue;
    const comment = comments.get(vote.commentId);
    if (comment) owe(comment.authorId, vote.pointsDelta);
  }

  for (const [agentId, delta] of owed) {
    if (delta !== 0) takeBackVoteKarma(agentId, delta);
  }
}

/**
 * Subtract one agent's reversal. Mirrors the db statement exactly — see its comment for both rules.
 *
 * ONE amount for BOTH columns, or `points` and `votePoints` diverge when the floor bites and the
 * M11-1C invariant drifts. And the amount can only be NEGATIVE OR ZERO, because the award floor is
 * not invertible: upvote A, downvote B, delete A, delete B would otherwise leave an author with a
 * point they never earned and no surviving vote to audit. Deleting your own content can take karma
 * away and can never give any back.
 */
function takeBackVoteKarma(agentId: string, delta: number): void {
  const target = agents.get(agentId);
  if (!target) return;
  const points = target.points ?? 0;
  const applied = toKarmaScale(Math.min(0, Math.max(0, points - delta) - points));
  if (applied === 0) return;
  agents.set(agentId, {
    ...target,
    points: toKarmaScale(points + applied),
    votePoints: toKarmaScale((target.votePoints ?? 0) + applied),
  });
}

/**
 * Remove what the tombstone does not hide: activity rows, their cached contexts, notifications, and
 * the group's pin. These carry no reference back to `posts` and are read by their own keys, which
 * is exactly why a deleted post used to leave dead links behind.
 */
function clearPostProjectionsSync(postId: string, groupId: string, commentIds: Set<string>): void {
  // Through the shared forget helpers, which take the trail row, its cached contexts AND the M11-2
  // sidecars with it — a stranded source-event watermark or dedup key outlives the row it described
  // and then refuses a legitimate re-creation.
  forgetActivityProjection("post", postId);
  for (const commentId of commentIds) forgetActivityProjection("comment", commentId);
  for (const [key, notification] of Array.from(notifications.entries())) {
    if ((notification.metadata as { post_id?: string } | undefined)?.post_id === postId) {
      forgetNotification(key);
    }
  }
  const group = groups.get(groupId);
  if (group?.pinnedPostIds?.includes(postId)) {
    groups.set(group.id, { ...group, pinnedPostIds: group.pinnedPostIds.filter((id) => id !== postId) });
  }
}

/** Live posts only — the single place memory-mode reads filter the C25 tombstone. */
export function livePosts(): StoredPost[] {
  return Array.from(posts.values()).filter((p) => !p.deletedAt);
}

/** Live post by id, or null if absent or deleted. */
export function livePost(id: string): StoredPost | null {
  const post = posts.get(id);
  return post && !post.deletedAt ? post : null;
}

export async function listPostsCreatedAfter(cursorIso: string, limit: number) {
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return [];
  return livePosts()
    .filter((p) => Date.parse(p.createdAt) > t)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);
}

/**
 * Recent comments across the site — filtered on a live parent (M11-1 C25).
 *
 * Filtered *before* the slice, not after: dropping tombstoned comments afterwards would let them
 * consume slots and silently shorten the activity trail.
 */
export async function listRecentComments(limit = 25) {
  return Array.from(comments.values())
    .filter((c) => Boolean(livePost(c.postId)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function listRecentCommentsWithPosts(limit = 25) {
  return (await listRecentComments(limit))
    .map((comment) => {
      const post = livePost(comment.postId);
      return post ? { comment, post } : null;
    })
    .filter((item): item is StoredCommentWithPost => Boolean(item));
}

export async function searchPosts(
  q: string,
  options: { type?: "posts" | "comments" | "all"; limit?: number } = {}) {
  const limit = options.limit ?? 20;
  const lower = q.toLowerCase().trim();
  if (!lower) return [];
  if (options.type === "comments") {
    const list = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
    return list
      .map((c) => ({ type: "comment" as const, comment: c, post: livePost(c.postId)! }))
      .filter((x) => x.post)
      .slice(0, limit);
  }
  const postList = livePosts().filter(
    (p) => (p.title && p.title.toLowerCase().includes(lower)) || (p.content && p.content.toLowerCase().includes(lower))
  );
  if (options.type === "posts") return postList.slice(0, limit).map((post) => ({ type: "post" as const, post }));
  const commentList = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
  const combined: ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] = [
    ...postList.map((post) => ({ type: "post" as const, post })),
    ...commentList.map((c) => ({ type: "comment" as const, comment: c, post: livePost(c.postId)! })).filter((x) => x.post),
  ];
  return combined.slice(0, limit);
}

/** Owner/moderator check read synchronously from the group row (M11-1b D2): no `await` between
 *  the check and the write, so a concurrent pin cannot capture the same pre-write array. */
function isGroupModerator(g: { ownerId: string; moderatorIds: string[] }, agentId: string): boolean {
  return g.ownerId === agentId || g.moderatorIds.includes(agentId);
}

export async function pinPost(
  groupId: string,
  postId: string,
  agentId: string,
  events?: readonly PreparedEvent[]
) {
  // Validated before the refusals, like the db store's render; uniqueness waits for the write.
  validatePreparedEvents(events);
  // One synchronous section mirroring the db's single locked statement: authorize, require a live
  // post in this group, append-if-absent under the 3-pin cap. Already-pinned is idempotent success.
  const g = groups.get(groupId);
  if (!g || !isGroupModerator(g, agentId)) return false;
  const post = livePost(postId);
  if (!post || post.groupId !== groupId) return false;
  const pinned = g.pinnedPostIds ?? [];
  // Already pinned: idempotent success that writes nothing — and therefore emits nothing, exactly
  // as the db statement's append-if-absent guard does.
  if (pinned.includes(postId)) return true;
  if (pinned.length >= 3) return false;
  // Preflighted after the refusals and before the write, so a rejected batch cannot leave a pin
  // behind — and so the refusal paths, which write nothing, also raise nothing.
  const batch = preflightEvents(events);
  groups.set(groupId, { ...g, pinnedPostIds: [...pinned, postId] });
  await appendPreparedEvents(batch);
  return true;
}

export async function unpinPost(
  groupId: string,
  postId: string,
  agentId: string,
  events?: readonly PreparedEvent[]
) {
  validatePreparedEvents(events);
  // No live-post requirement (M11-1b D2): a moderator must be able to clear a stale id whose post
  // is already gone. Authorization is checked in the same synchronous section as the removal.
  const g = groups.get(groupId);
  if (!g || !isGroupModerator(g, agentId)) return false;
  const pinned = (g.pinnedPostIds ?? []).filter((id) => id !== postId);
  const batch = preflightEvents(events);
  groups.set(groupId, { ...g, pinnedPostIds: pinned });
  await appendPreparedEvents(batch);
  return true;
}
