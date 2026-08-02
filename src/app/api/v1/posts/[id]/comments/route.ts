import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { createComment, listComments, getComment, getPost, getGroup, getAgentById, checkCommentRateLimit } from "@/lib/store";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { scheduleCommentMemoryIngest } from "@/lib/memory/platform-ingest";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const { id: postId } = await params;
    const sort = (request.nextUrl.searchParams.get("sort") as "top" | "new" | "controversial") || "top";
    const list = await listComments(postId, sort);
    const data = await Promise.all(
      list.map(async (c) => {
        const author = await getAgentById(c.authorId);
        return {
          id: c.id,
          content: c.content,
          author: author ? { name: author.name } : null,
          parent_id: c.parentId,
          upvotes: c.upvotes,
          created_at: c.createdAt,
        };
      })
    );
    return jsonResponse({ success: true, data });
  } catch {
    return errorResponse("Failed to list comments", undefined, 500);
  }
}

/**
 * The 429 for a refused comment, built from a fresh read of the cooldown and the daily cap.
 *
 * Called before the write and again if the write comes back null (M11-1 C16): the pre-check is the
 * ordinary path, and the second call resolves a race the pre-check cannot see — the claim now
 * lives inside the insert statement, so a concurrent comment from the same agent can take the
 * allowance in between. Only this checker computes `retry_after_seconds` / `daily_remaining`.
 */
async function commentCooldownRefusal(agentId: string): Promise<Response | null> {
  const rate = await checkCommentRateLimit(agentId);
  if (rate.allowed) return null;
  return errorResponse("Comment cooldown", "Please wait before posting another comment.", 429, {
    code: "rate_limited",
    extra: {
      retry_after_seconds: rate.retryAfterSeconds,
      daily_remaining: rate.dailyRemaining,
    },
  });
}

/**
 * `createComment` returning null means one of exactly two things (M11-1 C16 / C25): the post was
 * deleted between this handler's lookup and the insert, or the quota claim inside the insert
 * refused the request.
 *
 * **The post is the discriminator, not the quota.** A quota re-check can flip between the two
 * statements — the cooldown expires, or the day rolls over while the agent sits at the daily cap —
 * and would then answer "post not found" for a request that was really rate limited.
 */
/** M11-1b D3: the stable rejection for a parent that is not a live comment on this post. */
function invalidParentRefusal(): Response {
  return errorResponse(
    "parent comment not found on this post",
    "parent_id must reference a comment on the same post",
    400,
    { code: "invalid_parent" }
  );
}

/** True when parentId names a live comment belonging to postId. */
async function parentIsValid(postId: string, parentId: string): Promise<boolean> {
  const parent = await getComment(parentId);
  return Boolean(parent && parent.postId === postId);
}

async function classifyCommentRefusal(postId: string, agentId: string, parentId?: string): Promise<Response> {
  if (!(await getPost(postId))) return errorResponse("Post not found", undefined, 404);
  // The parent can vanish or move out of scope between the pre-check and the insert's gate
  // (M11-1b D3): re-derive it so a raced invalid parent answers as a validation error, never as
  // a fabricated cooldown.
  if (parentId && !(await parentIsValid(postId, parentId))) return invalidParentRefusal();
  return (
    (await commentCooldownRefusal(agentId)) ??
    errorResponse("Comment cooldown", "Please wait before posting another comment.", 429, {
      code: "rate_limited",
    })
  );
}

/**
 * The comment write itself: syntactic and parent validation BEFORE the rate-limit check (M11-1b
 * D3 — the pre-D3 order gave a rate-limited caller with an invalid parent the rate-limit shape,
 * promising a precedence the code did not have), then the cooldown, then the create.
 */
async function writeComment(request: NextRequest, postId: string, agentId: string, post: Awaited<ReturnType<typeof getPost>>): Promise<Response> {
  const body = await request.json();
  const content = body?.content?.trim();
  const parentId = body?.parent_id?.trim() || undefined;
  if (!content) {
    return errorResponse("content is required");
  }
  if (parentId && !(await parentIsValid(postId, parentId))) {
    return invalidParentRefusal();
  }

  const cooldown = await commentCooldownRefusal(agentId);
  if (cooldown) return cooldown;

  const comment = await createComment(postId, agentId, content, parentId);
  if (!comment) return classifyCommentRefusal(postId, agentId, parentId);
  if (post) scheduleCommentMemoryIngest(comment, post);
  return jsonResponse({
    success: true,
    data: {
      id: comment.id,
      content: comment.content,
      parent_id: comment.parentId,
      created_at: comment.createdAt,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const post = await getPost(postId);
  if (!post) {
    return errorResponse("Post not found", undefined, 404);
  }

  // A comment belongs to the post's group, so the school that owns that group decides who may
  // write here — not the host the request arrived on (M11-1 C20, review round 4).
  const group = await getGroup(post.groupId);
  if (group) {
    const schoolDenial = requireGroupSchoolAccess(agent, group);
    if (schoolDenial) return schoolDenial;
  }

  try {
    return await writeComment(request, postId, agent.id, post);
  } catch {
    return errorResponse("Failed to create comment", undefined, 500);
  }
}
