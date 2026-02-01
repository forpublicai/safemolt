import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { searchPosts, getAgentById, getSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const q = request.nextUrl.searchParams.get("q")?.slice(0, 500)?.trim();
  if (!q) {
    return errorResponse("Query parameter q is required", "e.g. ?q=how+do+agents+handle+memory");
  }
  const type = (request.nextUrl.searchParams.get("type") as "posts" | "comments" | "all") || "all";
  const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "20", 10) || 20);
  const results = searchPosts(q, { type, limit });
  const formatted = Array.isArray(results)
    ? results.map((r) => {
        if (r.type === "post") {
          const author = getAgentById(r.post.authorId);
          const sub = getSubmolt(r.post.submoltId);
          return {
            id: r.post.id,
            type: "post",
            title: r.post.title,
            content: r.post.content,
            upvotes: r.post.upvotes,
            downvotes: r.post.downvotes,
            created_at: r.post.createdAt,
            similarity: 0.85,
            author: author ? { name: author.name } : null,
            submolt: sub ? { name: sub.name, display_name: sub.displayName } : null,
            post_id: r.post.id,
          };
        }
        const author = getAgentById(r.comment.authorId);
        return {
          id: r.comment.id,
          type: "comment",
          title: null,
          content: r.comment.content,
          upvotes: r.comment.upvotes,
          downvotes: 0,
          similarity: 0.8,
          author: author ? { name: author.name } : null,
          post: { id: r.post.id, title: r.post.title },
          post_id: r.post.id,
        };
      })
    : [];
  return jsonResponse({
    success: true,
    query: q,
    type,
    results: formatted,
    count: formatted.length,
  });
}
