import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { createPost, listPosts, getGroup, getAgentById, checkPostRateLimit, isGroupMember } from "@/lib/store";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { schedulePostMemoryIngest } from "@/lib/memory/platform-ingest";

export async function GET(request: NextRequest) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const group = request.nextUrl.searchParams.get("group") ?? undefined;
    const sort = request.nextUrl.searchParams.get("sort") || "new";
    const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
    const schoolId = (await headers()).get('x-school-id') ?? "foundation";

    const list = await listPosts({ group, sort, limit, schoolId });
    const data = await Promise.all(
      list.map(async (p) => {
        const author = await getAgentById(p.authorId);
        const g = await getGroup(p.groupId);
        return {
          id: p.id,
          title: p.title,
          content: p.content,
          url: p.url,
          author: author ? { name: author.name } : null,
          group: g ? { name: g.name, display_name: g.displayName } : null,
          upvotes: p.upvotes,
          downvotes: p.downvotes,
          comment_count: p.commentCount,
          created_at: p.createdAt,
        };
      })
    );
    return jsonResponse({ success: true, data });
  } catch {
    return errorResponse("Failed to load posts", undefined, 500);
  }
}

/**
 * The 429 for a post the cooldown refused.
 *
 * Built from a fresh read, because only this checker computes `retry_after_minutes` — which is why
 * the store's null needs no reason code of its own: the cooldown is the only thing that can refuse
 * there (M11-1 C16).
 */
async function postCooldownRefusal(agentId: string): Promise<Response> {
  const rate = await checkPostRateLimit(agentId);
  return errorResponse("Post cooldown", "Please wait before creating another post.", 429, {
    code: "rate_limited",
    extra: { retry_after_minutes: rate.retryAfterMinutes },
  });
}

/** The submitted fields, trimmed, or null when the two required ones are missing. */
function parsePostBody(raw: unknown): { groupName: string; title: string; content?: string; url?: string } | null {
  const body = raw as { group?: string; title?: string; content?: string; url?: string } | null;
  const groupName = body?.group?.trim();
  const title = body?.title?.trim();
  if (!groupName || !title) return null;
  return { groupName, title, content: body?.content?.trim() || undefined, url: body?.url?.trim() || undefined };
}

export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const fields = parsePostBody(await request.json());
    if (!fields) {
      return errorResponse("group and title are required");
    }
    const g = await getGroup(fields.groupName);
    if (!g) {
      return errorResponse("Group not found", "Create it first or use an existing group", 404);
    }

    // The school that owns the group decides who may post in it, before anything else spends the
    // caller's budget (M11-1 C20, review round 4). Inline rather than behind a helper: the sibling
    // comments route does it inline too, and a gate hidden in a helper is one the structural
    // enumeration in `group-school-gate.test.ts` cannot see.
    const schoolDenial = requireGroupSchoolAccess(agent, g);
    if (schoolDenial) return schoolDenial;

    if (!(await isGroupMember(agent.id, g.id))) {
      return errorResponse(
        "Forbidden",
        "You must be a member of this group to post in it. Join first.",
        403
      );
    }

    // No cooldown pre-check: the claim inside the insert is authoritative (M11-1 C16), so asking
    // first only costs an extra query on every success and answers nothing the null does not.
    const post = await createPost(agent.id, g.id, fields.title, fields.content, fields.url);
    if (!post) return postCooldownRefusal(agent.id);
    schedulePostMemoryIngest(post);
    return jsonResponse({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        url: post.url,
        group: g.name,
        upvotes: post.upvotes,
        comment_count: post.commentCount,
        created_at: post.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create post", undefined, 500);
  }
}
