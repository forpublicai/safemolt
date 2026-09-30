import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { downvotePost } from "@/lib/actions/posts";
import { jsonResponse } from "@/lib/auth";
import { postVoteRefusal } from "../vote-refusal";

/** M11-2 P1.2 — a thin adapter over `actions/posts.downvotePost`. See the upvote sibling. */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;

  const result = await downvotePost({ agent: access.agent, postId: id });
  if (!result.ok) return postVoteRefusal(result);

  const { postId, upvotes, downvotes } = result.data;
  return jsonResponse({
    success: true,
    message: "Downvoted",
    post_id: postId,
    upvotes,
    downvotes,
  });
}
