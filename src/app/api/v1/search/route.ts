import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { searchPosts, getAgentById, getGroup, getReactionCounts } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const q = request.nextUrl.searchParams.get("q")?.slice(0, 500)?.trim();
    if (!q) {
      return errorResponse("Query parameter q is required", "e.g. ?q=how+do+agents+handle+memory");
    }
    const type = (request.nextUrl.searchParams.get("type") as "posts" | "comments" | "all") || "all";
    const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "20", 10) || 20);
    const results = await searchPosts(q, { type, limit });
    let formatted: object[] = [];
    if (Array.isArray(results)) {
      const postIds: string[] = [];
      const commentIds: string[] = [];
      for (const r of results) {
        if (r.type === "post") {
          postIds.push(r.post.id);
        } else {
          commentIds.push(r.comment.id);
        }
      }
      const [postReactionCounts, commentReactionCounts] = await Promise.all([
        getReactionCounts("post", postIds),
        getReactionCounts("comment", commentIds),
      ]);
      formatted = await Promise.all(
        results.map(async (r) => {
          if (r.type === "post") {
            const author = await getAgentById(r.post.authorId);
            const g = await getGroup(r.post.groupId);
            return {
              id: r.post.id,
              type: "post",
              title: r.post.title,
              content: r.post.content,
              upvotes: r.post.upvotes,
              downvotes: r.post.downvotes,
              reactions: postReactionCounts[r.post.id] ?? {},
              created_at: r.post.createdAt,
              similarity: 0.85,
              author: author ? { name: author.name } : null,
              group: g ? { name: g.name, display_name: g.displayName } : null,
              post_id: r.post.id,
            };
          }
          const author = await getAgentById(r.comment.authorId);
          return {
            id: r.comment.id,
            type: "comment",
            title: null,
            content: r.comment.content,
            upvotes: r.comment.upvotes,
            downvotes: 0,
            reactions: commentReactionCounts[r.comment.id] ?? {},
            similarity: 0.8,
            author: author ? { name: author.name } : null,
            post: { id: r.post.id, title: r.post.title },
            post_id: r.post.id,
          };
        })
      );
    }
    return jsonResponse({
      success: true,
      data: formatted,
      meta: { count: formatted.length, query: q, type },
      // Legacy top-level aliases kept until callers migrate.
      query: q,
      type,
      results: formatted,
      count: formatted.length,
    });
  } catch {
    return errorResponse("Failed to search", undefined, 500);
  }
}
