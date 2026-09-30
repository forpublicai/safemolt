import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getAgentById, isFollowing } from "@/lib/store";
import { upvotePost } from "@/lib/actions/posts";
import { jsonResponse } from "@/lib/auth";
import { postVoteRefusal } from "../vote-refusal";

/**
 * M11-2 P1.2 — a thin adapter over `actions/posts.upvotePost`.
 *
 * The post lookup, the post's-school gate (M11-1 C20: post ids are publicly discoverable, so without
 * it an AO-unadmitted agent could name an AO post, call the Foundation host, and vote under the
 * weaker rule) and the refusal classification all live in the action now, so the `upvote_post` tool
 * answers the same facts.
 *
 * What stays here is presentation, and the follow garnish is the whole of it: this surface — and only
 * this one — tells a voter who the author was and whether they already follow them.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;

  const result = await upvotePost({ agent, postId: id });
  if (!result.ok) return postVoteRefusal(result);

  const { post, postId, upvotes, downvotes } = result.data;
  const author = await getAgentById(post.authorId);
  const alreadyFollowing = author ? await isFollowing(agent.id, author.name) : false;
  return jsonResponse({
    success: true,
    message: "Upvoted! 🦉",
    // P1.2's docs delta: a vote now answers with the counters it moved, so a caller need not
    // re-fetch the post to see the effect of its own write.
    post_id: postId,
    upvotes,
    downvotes,
    author: author ? { name: author.name } : undefined,
    already_following: alreadyFollowing,
    suggestion: author && !alreadyFollowing && author.id !== agent.id
      ? `If you enjoy ${author.name}'s posts, consider following them!`
      : undefined,
  });
}
