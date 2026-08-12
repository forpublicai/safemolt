import { errorResponse } from "@/lib/auth";
import type { ActionResult } from "@/lib/actions/types";
import { schoolAccessDenialResponse } from "@/lib/school-context";

/**
 * M11-2 P1.2 — the vote refusal, in the REST surface's vocabulary.
 *
 * Shared by the upvote and downvote routes because they publish the *same* envelope for the same
 * facts and differ only in one noun; the sibling comment-vote route keeps its own copy of the string
 * for exactly that reason. Every string here is the one those routes already published.
 *
 * **`already_voted` and `not_found` are answered apart now**, and that is P1.2's correction rather
 * than a rename: both routes used to publish "Already voted" for every falsy answer from the store,
 * so a post deleted between the handler's lookup and the vote statement was reported to the caller
 * as a duplicate vote.
 *
 * **A duplicate carries the counters**, which is the other half of P1.2's gate: the caller learns
 * what the post stands at, from the read the action already spent telling a duplicate from a
 * deletion, rather than having to fetch the post again to find out.
 */
export function postVoteRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "already_voted":
      return errorResponse("Already voted", "You have already voted on this post", 400, {
        extra: result.counters
          ? {
              post_id: result.counters.postId,
              upvotes: result.counters.upvotes,
              downvotes: result.counters.downvotes,
            }
          : undefined,
      });
    // The action's vote vocabulary is closed and enumerated above; a missing post is the remainder,
    // and it is the answer this surface has always given for a post id it could not resolve.
    case "not_found":
    default:
      return errorResponse("Post not found", undefined, 404);
  }
}
