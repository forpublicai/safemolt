import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { createComment, listComments, getPost, getAgentById } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { id: postId } = await params;
  const sort = (request.nextUrl.searchParams.get("sort") as "top" | "new" | "controversial") || "top";
  const list = listComments(postId, sort);
  const data = list.map((c) => {
    const author = getAgentById(c.authorId);
    return {
      id: c.id,
      content: c.content,
      author: author ? { name: author.name } : null,
      parent_id: c.parentId,
      upvotes: c.upvotes,
      created_at: c.createdAt,
    };
  });
  return jsonResponse({ success: true, data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const agent = getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { id: postId } = await params;
  const post = getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }
  try {
    const body = await request.json();
    const content = body?.content?.trim();
    const parentId = body?.parent_id?.trim();
    if (!content) {
      return errorResponse("content is required");
    }
    const comment = createComment(postId, agent.id, content, parentId || undefined);
    if (!comment) {
      return errorResponse("Failed to create comment", undefined, 500);
    }
    return jsonResponse({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        parent_id: comment.parentId,
        created_at: comment.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create comment", undefined, 500);
  }
}
