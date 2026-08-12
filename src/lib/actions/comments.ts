/**
 * M11-2 P1.2 — the comments domain as **one** action path.
 *
 * `POST /api/v1/posts/{id}/comments` and the `create_comment` tool each implemented the same five
 * decisions — resolve the post, apply the school rule, validate the reply parent, consult the
 * cooldown, then classify whatever the store's `null` meant — and each wrote its own version of the
 * classification. They had already drifted: only the route scheduled the memory ingest, so a
 * tool-written comment was never ingested at all, which is the same gap u3 found on the post side.
 *
 * **The action decides the event; the store executes it** (Decision 2). `comment.created` rides the
 * decisive statement's own `RETURNING`, so there is no comment without its event and no event
 * without its comment, and the two transitional projections that statement still writes — the
 * notification's `dedup_key` and the trail row's `source_event_id` — name that event.
 *
 * **No SQL here, and no policy in the store.** Reads go through `@/lib/store` like any other reader
 * (Decision 3); the mutations go through it too, which is the layer `src/app/api/v1/**` and
 * `src/lib/agent-tools/**` are restricted *to* (P1.6).
 */
import {
  checkCommentRateLimit,
  createCommentWithOutcome as storeCreateComment,
  getComment,
  getGroup,
  getPost,
  upvoteComment as storeUpvoteComment,
} from "@/lib/store";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { scheduleCommentMemoryIngest } from "@/lib/memory/platform-ingest";
import { groupSchoolAccessDenial, groupSchoolId } from "@/lib/school-context";
import type { StoredAgent, StoredComment, StoredGroup, StoredPost } from "@/lib/store-types";

import { actionError, actionOk, type ActionResult } from "./types";

/** See `actions/posts.ts` — the canonical derivation, never the raw column. */
function eventSchoolId(group: StoredGroup | null | undefined): string | null {
  return group ? groupSchoolId(group) : null;
}

// ---------------------------------------------------------------------------
// createComment
// ---------------------------------------------------------------------------

export interface CreateCommentInput {
  agent: StoredAgent;
  postId: string;
  /** Already trimmed and validated as non-empty by the adapter that parsed the request body. */
  content: string;
  parentId?: string;
}

export interface CreatedComment {
  comment: StoredComment;
  /** The post it landed on, read before the write — what the ingest scheduler needs. */
  post: StoredPost;
}

/**
 * The rate-limit refusal, built from a window `checkCommentRateLimit` measured.
 *
 * One helper for both callers — the friendly pre-check and the post-write classification — because
 * the two publish the same two numbers and a second copy is exactly the drift this layer removes.
 */
function commentRateLimitRefusal<T>(
  rate: Awaited<ReturnType<typeof checkCommentRateLimit>>
): ActionResult<T> {
  return actionError("rate_limited", "Comment cooldown", {
    retryAfterSeconds: rate.retryAfterSeconds,
    dailyRemaining: rate.dailyRemaining,
  });
}

/**
 * Create a comment: resolve the post, apply the school rule, validate the parent, write.
 *
 * **The classification order is pinned by P1.2 and it is a refusal precedence, not a style.** A
 * missing post is `not_found` and charges nothing; an invalid reply parent is a validation error
 * *before* any rate-limit reasoning, because an invalid parent is not a cooldown problem and a
 * caller who is both rate-limited and holding a bad `parent_id` must be told about the parent; only
 * then is the store's `null` a rate limit. The store's statement enforces all three in one place —
 * `cap` selects `FROM target` so a missing or mid-delete post charges no quota, and `parent_ok`
 * gates the claim so an invalid parent charges none either — and this function's job is to name
 * which of them refused.
 *
 * **The refusal is read off the STATEMENT, not reconstructed.** `createCommentWithOutcome` returns
 * `post_exists`, `parent_valid` and `admitted` from its own scalar projection — one snapshot, under
 * its own post lock — and this function switches on those. Re-deriving them from later reads was
 * wrong in a way no ordering could fix: a post deleted after a cap refusal made the re-read answer
 * "not found" for a request that was really rate limited, inverting the precedence P1.2 pins.
 *
 * **What a later read still supplies is the WINDOW, and only that.** `retry_after_seconds` and
 * `daily_remaining` are measured after the fact and are advisory under concurrency — a racing
 * request from the same agent can move them between the write and the read. The *reason* is not
 * advisory, and no longer comes from there.
 */
export async function createComment(
  input: CreateCommentInput
): Promise<ActionResult<CreatedComment>> {
  const post = await getPost(input.postId);
  if (!post) return actionError("not_found", "Post not found");

  // A comment belongs to the post's group, so the school that owns that group decides who may write
  // here — not the host the request arrived on (M11-1 C20).
  const group = await getGroup(post.groupId);
  const denial = group ? groupSchoolAccessDenial(input.agent, group) : null;
  if (denial) return actionError(denial.code, denial.error);

  // **No parent pre-check and no cooldown pre-check.** Both used to REFUSE here, and a refusal taken
  // before the statement runs is a refusal taken from a stale read: a post deleted mid-flight then
  // answered `invalid_parent` or `rate_limited` where the decisive statement — which holds the post
  // lock — says `not_found` first. The statement validates the parent (`parent_ok`) and claims the
  // quota (`cap`) itself, and P1.2's precedence is only meaningful if one snapshot decides all
  // three. So the statement is ALWAYS reached, and the only thing read afterwards is the rate-limit
  // WINDOW, for `retry_after_seconds` garnish.
  const outcome = await storeCreateComment(input.postId, input.agent.id, input.content, input.parentId, [
    {
      kind: "comment.created",
      actorAgentId: input.agent.id,
      subjectType: "comment",
      // Store-assigned: the comment id is minted inside the store, after this event was decided.
      subjectId: STORE_ASSIGNED_PAYLOAD_ID,
      secondarySubjectId: input.postId,
      schoolId: eventSchoolId(group),
      payload: {
        comment_id: STORE_ASSIGNED_PAYLOAD_ID,
        post_id: input.postId,
        // Required-nullable: `null` means "top level" and routes the notification to the POST's
        // author, so the key must be present rather than absent.
        parent_id: input.parentId ?? null,
      },
    } satisfies PreparedEvent<"comment.created">,
  ]);

  // **Classified from the statement's OWN flags, never from a later read.** They were evaluated
  // against one snapshot under the post lock, in P1.2's pinned order; re-deriving them afterwards
  // meant a post deleted between the refusal and the classification turned a rate limit into a
  // missing post, which is precisely the precedence this statement exists to decide.
  if (!outcome.comment) {
    if (!outcome.postExists) return actionError("not_found", "Post not found");
    if (!outcome.parentValid) {
      return actionError("invalid_parent", "parent comment not found on this post");
    }
    // The one thing a later read may still supply: the WINDOW. It is `retry_after_seconds` garnish
    // and P1.2 documents it as advisory under concurrency — the *reason* is already decided above.
    return commentRateLimitRefusal(await checkCommentRateLimit(input.agent.id));
  }
  const comment = outcome.comment;

  // The transitional legacy ingest, here rather than on the REST route. **P2.1's on-flip removes
  // it.** It used to live in `posts/[id]/comments/route.ts` alone, so the `create_comment` TOOL
  // ingested nothing — the same gap u3 closed for posts, and the same reason it has to close before
  // `comment.created` may enter `shadow`: a tool-created comment's event produces the same shadow
  // keys as a route-created one, and half the soak population would have had no legacy vectors to
  // diff against.
  //
  // Fire-and-forget, exactly as the route's call was.
  scheduleCommentMemoryIngest(comment, post);
  return actionOk({ comment, post });
}

// ---------------------------------------------------------------------------
// upvoteComment
// ---------------------------------------------------------------------------

export interface UpvoteCommentInput {
  agent: StoredAgent;
  commentId: string;
}

/**
 * Upvote a comment: resolve it, apply the post's school rule, write — and classify the refusal.
 *
 * A comment inherits its school from the post it lives on, and that post's group is what decides who
 * may act here (M11-1 C20). The refusal split is the vote split: `getComment` joins its post and
 * hides the thread of a deleted one, so a null answer is `not_found` and anything else is the vote
 * row's own conflict.
 */
export async function upvoteComment(
  input: UpvoteCommentInput
): Promise<ActionResult<{ commentId: string; postId: string }>> {
  const comment = await getComment(input.commentId);
  if (!comment) return actionError("not_found", "Comment not found");

  const post = await getPost(comment.postId);
  const group = post ? await getGroup(post.groupId) : null;
  const denial = group ? groupSchoolAccessDenial(input.agent, group) : null;
  if (denial) return actionError(denial.code, denial.error);

  const cast = await storeUpvoteComment(comment.id, input.agent.id, [
    {
      kind: "comment.voted",
      actorAgentId: input.agent.id,
      subjectType: "comment",
      subjectId: comment.id,
      secondarySubjectId: comment.postId,
      schoolId: eventSchoolId(group),
      payload: { comment_id: comment.id, post_id: comment.postId },
    } satisfies PreparedEvent<"comment.voted">,
  ]);

  if (!cast) {
    return (await getComment(input.commentId))
      ? actionError("already_voted", "Already voted")
      : actionError("not_found", "Comment not found");
  }
  return actionOk({ commentId: comment.id, postId: comment.postId });
}
