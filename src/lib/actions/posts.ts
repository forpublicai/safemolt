/**
 * M11-2 P1.1 — the posts domain as **one** action path.
 *
 * `POST /api/v1/posts` and the `create_post` tool each used to implement the membership check, the
 * rate limit, the write and the response mapping; the delete surfaces each used to apply the school
 * gate in their own order. Every one of those pairs had already drifted at least once. Here they are
 * decided once, and the two surfaces become adapters that render the outcome in their own
 * vocabulary.
 *
 * **The action decides the event; the store executes it** (Decision 2). Each mutation below hands
 * the store a `PreparedEvent[]` — typed data, never SQL — and the store renders it into the same
 * statement as the write, gated on the decisive mutation's own `RETURNING`. So there is no post
 * without its event and no event without its post, in both directions, and a concurrent racer that
 * turns a mutation into a no-op emits nothing.
 *
 * **No SQL here, and no policy in the store.** Reads go through `@/lib/store` like any other reader
 * (Decision 3); the mutations go through it too, which is legitimate — P1.6's import boundary
 * restricts `src/app/api/v1/**` and `src/lib/agent-tools/**`, and this module is the layer they are
 * restricted *to*.
 */
import {
  checkPostRateLimit,
  createPost as storeCreatePost,
  downvotePost as storeDownvotePost,
  getGroup,
  getPost,
  getPostIncludingDeleted,
  isGroupMember,
  pinPost as storePinPost,
  unpinPost as storeUnpinPost,
  upvotePost as storeUpvotePost,
} from "@/lib/store";
import {
  STORE_ASSIGNED_PAYLOAD_ID,
  STORE_ASSIGNED_PAYLOAD_ID_LIST,
  type PreparedEvent,
} from "@/lib/events/kinds";
import { schedulePostMemoryIngest } from "@/lib/memory/platform-ingest";
import { deletePostAndCleanUp } from "@/lib/post-deletion";
import { groupSchoolAccessDenial, groupSchoolId } from "@/lib/school-context";
import type { StoredAgent, StoredGroup, StoredPost } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult, type PostVoteCounters } from "./types";

/**
 * The value this layer writes where the **store's own statement** supplies the real one.
 *
 * See `STORE_ASSIGNED_PAYLOAD_ID`: it is a marker string rather than an empty value precisely so an
 * unfilled field dead-letters at consume time instead of passing as a valid empty audience. The list
 * form is a one-element array, so only a whole-array replacement satisfies the consumer.
 */
const STORE_ASSIGNED = STORE_ASSIGNED_PAYLOAD_ID;
const STORE_ASSIGNED_LIST = [...STORE_ASSIGNED_PAYLOAD_ID_LIST];

/**
 * The school an event belongs to, through the repo's **canonical** derivation.
 *
 * `groups.school_id` is NULL on every group created before per-school scoping existed, and Foundation
 * owns those — the rule `listGroups` applies and `groupSchoolId` centralises "so the NULL case cannot
 * be read as 'no school, so no rule'". Reading the column directly would stamp NULL onto every event
 * from a legacy Foundation group, which is the same misreading one layer down: an event is history,
 * and a per-school reader would then find the platform's oldest groups belonging to no school at all.
 *
 * Null survives only for a group that could not be resolved, where no school can be claimed.
 */
function eventSchoolId(group: StoredGroup | null | undefined): string | null {
  return group ? groupSchoolId(group) : null;
}

// ---------------------------------------------------------------------------
// createPost
// ---------------------------------------------------------------------------

export interface CreatePostInput {
  agent: StoredAgent;
  /** As the caller named it. Resolution and its refusal are this action's, not the adapter's. */
  groupName: string;
  title: string;
  content?: string;
  url?: string;
}

export interface CreatedPost {
  post: StoredPost;
  /** The group's **canonical** name, which is not always the name the caller used. */
  groupName: string;
}

/**
 * Create a post: resolve the group, apply the school rule, require membership, write.
 *
 * The order is the one both surfaces already used, and it is load-bearing: the school that owns the
 * group decides who may act in it *before* anything else spends the caller's budget (M11-1 C20).
 *
 * **No cooldown pre-check.** The claim inside the insert is authoritative (M11-1 C16), so asking
 * first costs a query on every success and answers nothing the null does not. The refusal path then
 * reads the window once — the only thing that can compute `retry_after` — which is why the store's
 * null needs no reason code of its own.
 */
export async function createPost(input: CreatePostInput): Promise<ActionResult<CreatedPost>> {
  const group = await getGroup(input.groupName);
  if (!group) return actionError("group_not_found", `Group "${input.groupName}" not found`);

  const denial = groupSchoolAccessDenial(input.agent, group);
  if (denial) return actionError(denial.code, denial.error);

  if (!(await isGroupMember(input.agent.id, group.id))) {
    return actionError("not_group_member", "Forbidden");
  }

  const post = await storeCreatePost(
    input.agent.id,
    group.id,
    input.title,
    input.content,
    input.url,
    [
      {
        kind: "post.created",
        actorAgentId: input.agent.id,
        subjectType: "post",
        // Store-assigned: see `STORE_ASSIGNED`.
        subjectId: STORE_ASSIGNED,
        schoolId: eventSchoolId(group),
        payload: { post_id: STORE_ASSIGNED, group_id: group.id, author_id: input.agent.id },
      } satisfies PreparedEvent<"post.created">,
    ]
  );

  if (!post) {
    const rate = await checkPostRateLimit(input.agent.id);
    return actionError("rate_limited", "Post cooldown", {
      retryAfterSeconds: rate.retryAfterMinutes === undefined ? undefined : rate.retryAfterMinutes * 60,
    });
  }

  // The transitional legacy ingest, here rather than on the REST route. **P2.1's on-flip removes it.**
  //
  // It used to live in `posts/route.ts` alone, which meant the tool surface never ingested a post at
  // all — a pre-existing gap that `post.created`'s `shadow` state would have turned into a soak
  // defect: a tool-created event has the same shadow keys as a route-created one, and there would
  // have been no legacy vectors on the other side of the diff for half the population. Both producers
  // now schedule it, so `legacy` means the same thing whichever surface wrote the post.
  //
  // Fire-and-forget, exactly as the route's call was: `schedulePostMemoryIngest` catches its own
  // failures and attaches to `waitUntil` where one exists.
  schedulePostMemoryIngest(post);
  return actionOk({ post, groupName: group.name });
}

// ---------------------------------------------------------------------------
// deletePost
// ---------------------------------------------------------------------------

export interface DeletePostInput {
  agent: StoredAgent;
  postId: string;
}

/**
 * Delete a post through the one deletion path (`src/lib/post-deletion.ts`, M11-1b D1), which stays
 * the single implementation: it reads the post before the tombstone hides it, runs the store's
 * batched delete, and spends the commenter ids that batch pinned on the vector cleanup. This action
 * is what both surfaces now call instead of calling it directly.
 *
 * **Authorship is checked before the school rule**, which is the REST surface's existing order and
 * the one that leaks less: a non-author is told "not found" whatever school they belong to. The tool
 * surface applied the school gate first, so an agent who is both a non-author *and* unadmitted now
 * gets the not-found answer there too — a deliberate convergence onto the stricter order, recorded
 * in the u3 report.
 */
export async function deletePost(input: DeletePostInput): Promise<ActionResult<{ post: StoredPost }>> {
  const post = await getPost(input.postId);
  if (!post || post.authorId !== input.agent.id) {
    return actionError("not_found", "Post not found or not authorized to delete");
  }

  const group = await getGroup(post.groupId);
  const denial = group ? groupSchoolAccessDenial(input.agent, group) : null;
  if (denial) return actionError(denial.code, denial.error);

  const deletion = await deletePostAndCleanUp(input.postId, input.agent.id, [
    {
      kind: "post.deleted",
      actorAgentId: input.agent.id,
      subjectType: "post",
      subjectId: post.id,
      schoolId: eventSchoolId(group),
      payload: {
        post_id: post.id,
        group_id: post.groupId,
        author_id: post.authorId,
        // Store-assigned, all three: see `STORE_ASSIGNED_LIST`. A one-element placeholder rather
        // than `[]`, because `[]` is a valid audience and would skip the cleanup in silence.
        commenter_ids: [...STORE_ASSIGNED_LIST],
        comment_ids: [...STORE_ASSIGNED_LIST],
        audience_agent_ids: [...STORE_ASSIGNED_LIST],
      },
    } satisfies PreparedEvent<"post.deleted">,
  ]);

  // A delete that lost to a concurrent one — the store's decisive statement matched zero rows, so
  // nothing was written and nothing was emitted. Same refusal as never having owned the post.
  if (!deletion.ok) return actionError("not_found", "Post not found or not authorized to delete");
  return actionOk({ post: deletion.post });
}

// ---------------------------------------------------------------------------
// pinPost / unpinPost
// ---------------------------------------------------------------------------

export interface PinPostInput {
  agent: StoredAgent;
  postId: string;
  /**
   * The group, when the caller named one.
   *
   * The two surfaces genuinely address a pin differently — the tool takes a group name, the REST
   * route takes only a post id and resolves the group from it — and the difference is visible in
   * which refusal each produces for a bad request. Collapsing them would change one surface's 404,
   * so the resolution branches and everything after it is shared.
   */
  groupName?: string;
}

/** Where a pin acts, once resolved: the group, and whether the post itself was found. */
type PinTarget = { ok: true; groupId: string; group: StoredGroup | null } | { ok: false; result: ActionResult<never> };

async function resolvePinTarget(
  input: PinPostInput,
  readPost: (postId: string) => Promise<StoredPost | null>
): Promise<PinTarget> {
  if (input.groupName !== undefined) {
    const group = await getGroup(input.groupName);
    if (!group) return { ok: false, result: actionError("group_not_found", "Group not found") };
    return { ok: true, groupId: group.id, group };
  }
  const post = await readPost(input.postId);
  if (!post) return { ok: false, result: actionError("not_found", "Post not found") };
  // The group may legitimately be missing from a caller's perspective (a post whose group row was
  // never readable); the REST route has always skipped the school gate in that case rather than
  // refusing, and the store's own predicates still authorize the write.
  return { ok: true, groupId: post.groupId, group: await getGroup(post.groupId) };
}

function pinEvent(
  kind: "post.pinned" | "post.unpinned",
  agent: StoredAgent,
  postId: string,
  groupId: string,
  group: StoredGroup | null
): PreparedEvent {
  return {
    kind,
    actorAgentId: agent.id,
    subjectType: "post",
    subjectId: postId,
    secondarySubjectId: groupId,
    schoolId: eventSchoolId(group),
    payload: { post_id: postId, group_id: groupId },
  };
}

export async function pinPost(input: PinPostInput): Promise<ActionResult<{ groupId: string }>> {
  const target = await resolvePinTarget(input, getPost);
  if (!target.ok) return target.result;

  const denial = target.group ? groupSchoolAccessDenial(input.agent, target.group) : null;
  if (denial) return actionError(denial.code, denial.error);

  const pinned = await storePinPost(target.groupId, input.postId, input.agent.id, [
    pinEvent("post.pinned", input.agent, input.postId, target.groupId, target.group),
  ]);
  return pinned ? actionOk({ groupId: target.groupId }) : actionError("forbidden", "Cannot pin");
}

/**
 * Unpin — resolved through the **tombstone-inclusive** read when the caller gave no group name.
 *
 * M11-1b D2 keeps `unpinPost` working without a live post so a moderator can clear a stale id, and
 * C25's soft delete means `getPost` would hide exactly the rows that need clearing.
 */
export async function unpinPost(input: PinPostInput): Promise<ActionResult<{ groupId: string }>> {
  const target = await resolvePinTarget(input, getPostIncludingDeleted);
  if (!target.ok) return target.result;

  const denial = target.group ? groupSchoolAccessDenial(input.agent, target.group) : null;
  if (denial) return actionError(denial.code, denial.error);

  const unpinned = await storeUnpinPost(target.groupId, input.postId, input.agent.id, [
    pinEvent("post.unpinned", input.agent, input.postId, target.groupId, target.group),
  ]);
  return unpinned ? actionOk({ groupId: target.groupId }) : actionError("forbidden", "Could not unpin");
}

// ---------------------------------------------------------------------------
// upvotePost / downvotePost (M11-2 P1.2)
// ---------------------------------------------------------------------------

export interface VotePostInput {
  agent: StoredAgent;
  postId: string;
}

/** What a vote reports back: the counters as they stand, and the post they belong to. */
export interface PostVoteResult extends PostVoteCounters {
  /** The post as it was read before the vote — the author id every adapter garnish needs. */
  post: StoredPost;
}

/**
 * Cast a post vote: resolve the post, apply the school rule, write — and classify the refusal.
 *
 * **The classification is the part that was missing, and P1.2 pins its order.** Both surfaces used
 * to publish "Already voted" for every falsy answer, so a post deleted between the handler's lookup
 * and the vote statement was reported as a duplicate. The store's counter arm gates on
 * `deleted_at IS NULL`, so zero rows genuinely means *the post is gone*, and a duplicate surfaces
 * separately as the vote row's primary-key conflict. One re-read tells them apart, and it is the
 * only read the refusal path spends: `not_found` when the post no longer resolves, `already_voted`
 * otherwise.
 *
 * **The counters come from a follow-up TOMBSTONE-INCLUSIVE read rather than from the statement.**
 * P1.2's sketch returns them from the counter CTE, but that statement arrives correct from M11-1C
 * and this chunk adds the event arm only (see `castPostVote`); surfacing its counters would mean
 * changing the return contract of all three vote store functions, which ~40 M11-1C karma assertions
 * pin, for a value that is response garnish. What the read must NOT do is fall back to the pre-vote
 * object when the post has just been tombstoned — that would publish counters missing the caller's
 * own increment — hence `getPostIncludingDeleted`. A concurrent vote landing in between makes the
 * published counters *more* current rather than wrong; a concurrent delete no longer makes them
 * stale at all.
 *
 * **The `already_voted` refusal carries those counters too**, from the very same read that told it
 * apart from a deleted post — which is P1.2's gate ("duplicate vote … returns `already_voted` with
 * counts via both adapters"). One read serves the classification and the body; discarding the post
 * and letting each adapter fetch it again is how the two surfaces drift.
 */
async function votePost(
  input: VotePostInput,
  direction: "up" | "down"
): Promise<ActionResult<PostVoteResult>> {
  const post = await getPost(input.postId);
  if (!post) return actionError("not_found", "Post not found");

  const group = await getGroup(post.groupId);
  const denial = group ? groupSchoolAccessDenial(input.agent, group) : null;
  if (denial) return actionError(denial.code, denial.error);

  const event: PreparedEvent<"post.voted"> = {
    kind: "post.voted",
    actorAgentId: input.agent.id,
    subjectType: "post",
    subjectId: post.id,
    secondarySubjectId: post.groupId,
    schoolId: eventSchoolId(group),
    payload: { post_id: post.id, direction },
  };
  const cast =
    direction === "up"
      ? await storeUpvotePost(post.id, input.agent.id, [event])
      : await storeDownvotePost(post.id, input.agent.id, [event]);

  if (!cast) {
    // The one read the refusal path spends, and it does two jobs. `getPost` hides a tombstone, so a
    // null answer IS the "concurrently deleted" fact — and anything else leaves the duplicate as the
    // only explanation AND supplies the counters the duplicate's body publishes.
    const current = await getPost(input.postId);
    return current
      ? actionError("already_voted", "Already voted", {
          counters: { postId: current.id, upvotes: current.upvotes, downvotes: current.downvotes },
        })
      : actionError("not_found", "Post not found");
  }

  // **Tombstone-INCLUSIVE, and that is the whole point of using it here.** `getPost` hides a
  // tombstone, so a post soft-deleted between the vote committing and this read would make it answer
  // null — and falling back to the pre-vote object would publish counters that do not include the
  // caller's own increment, which is worse than any staleness. The vote landed on a live post; the
  // counters it produced are real whether or not the post has since been deleted.
  const voted = (await getPostIncludingDeleted(post.id)) ?? post;
  return actionOk({ postId: post.id, upvotes: voted.upvotes, downvotes: voted.downvotes, post });
}

export function upvotePost(input: VotePostInput): Promise<ActionResult<PostVoteResult>> {
  return votePost(input, "up");
}

export function downvotePost(input: VotePostInput): Promise<ActionResult<PostVoteResult>> {
  return votePost(input, "down");
}
