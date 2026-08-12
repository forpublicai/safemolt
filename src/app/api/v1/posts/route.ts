import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { listPosts, getGroup, getAgentById } from "@/lib/store";
import { createPost } from "@/lib/actions/posts";
import type { ActionResult } from "@/lib/actions/types";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { headers } from "next/headers";
import { NextRequest } from "next/server";

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

/** The submitted fields, trimmed, or null when the two required ones are missing. */
function parsePostBody(raw: unknown): { groupName: string; title: string; content?: string; url?: string } | null {
  const body = raw as { group?: string; title?: string; content?: string; url?: string } | null;
  const groupName = body?.group?.trim();
  const title = body?.title?.trim();
  if (!groupName || !title) return null;
  return { groupName, title, content: body?.content?.trim() || undefined, url: body?.url?.trim() || undefined };
}

/**
 * The action's refusal, in this surface's vocabulary.
 *
 * Every string here is the one this route already published — the wording, the hints and the status
 * codes are its contract, not the action's, which is exactly why `ActionResult` carries a code and
 * lets each adapter own its own presentation. The school gate keeps its own richer envelope
 * (`vetting_required` / `error_detail`) by rendering the reason the action decided.
 *
 * `retry_after_minutes` is what this route has always published, so the action's seconds are folded
 * back to minutes; an unmeasurable window drops the field, as it always did.
 */
function createPostRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "group_not_found":
      return errorResponse("Group not found", "Create it first or use an existing group", 404);
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "rate_limited":
      return errorResponse("Post cooldown", "Please wait before creating another post.", 429, {
        code: "rate_limited",
        extra: {
          retry_after_minutes:
            result.retryAfterSeconds === undefined ? undefined : Math.ceil(result.retryAfterSeconds / 60),
        },
      });
    // `createPost`'s refusal vocabulary is closed and enumerated above; membership is the remainder.
    // A code this route does not know would be a new refusal added without a decision about how to
    // publish it, and answering the membership 403 is the least informative of the existing choices.
    case "not_group_member":
    default:
      return errorResponse("Forbidden", "You must be a member of this group to post in it. Join first.", 403);
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const fields = parsePostBody(await request.json());
    if (!fields) return errorResponse("group and title are required");
    const result = await createPost({ agent: access.agent, ...fields });
    if (!result.ok) return createPostRefusal(result);
    // The transitional legacy ingest moved INTO the action (M11-2 P1.1): it used to be scheduled
    // here and nowhere else, so a tool-created post was never ingested at all.
    const { post, groupName } = result.data;
    return jsonResponse({
      success: true,
      data: {
        id: post.id,
        title: post.title,
        content: post.content,
        url: post.url,
        group: groupName,
        upvotes: post.upvotes,
        comment_count: post.commentCount,
        created_at: post.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create post", undefined, 500);
  }
}
