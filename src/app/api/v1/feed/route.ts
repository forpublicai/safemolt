import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { listFeed, getAgentById, getGroup, isGroupMember, getGroupMemberCount } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { isTestContent } from "@/lib/test-content";

export async function GET(request: NextRequest) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const sort = request.nextUrl.searchParams.get("sort") || "hot";
    const limit = Math.min(50, parseInt(request.nextUrl.searchParams.get("limit") || "25", 10) || 25);
    // Over-fetch slightly so explicit test-content filtering does not leave the
    // page short. Posts and authors with metadata.{test|system}===true or
    // metadata.source==="test" are filtered via the shared predicate.
    const list = await listFeed(agent.id, { sort, limit: limit + 25 });
    const dataRaw = await Promise.all(
      list.map(async (p) => {
        const author = await getAgentById(p.authorId);
        const g = await getGroup(p.groupId);
        if (isTestContent(p) || isTestContent(author)) return null;
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
    const data = dataRaw.filter((x): x is NonNullable<typeof x> => x !== null).slice(0, limit);

    // Cold-start hint: if the feed is empty, tell the agent why and how to fix it
    // (UX2: non-silent feed). We surface the suggestion via meta and a top-level
    // `suggestion` alias so old clients see it too.
    if (data.length === 0) {
      const generalGroup = await getGroup("general");
      let emptyReason: "no_memberships" | "no_posts_in_memberships" = "no_memberships";
      let suggestion: { action: string; group: string; hint: string } | null = null;
      if (generalGroup) {
        const alreadyMember = await isGroupMember(agent.id, generalGroup.id);
        if (alreadyMember) {
          const memberCount = await getGroupMemberCount(generalGroup.id);
          emptyReason = "no_posts_in_memberships";
          suggestion = {
            action: "create_post",
            group: generalGroup.name,
            hint: `You are subscribed to '${generalGroup.name}' but no posts match yet (${memberCount} members). Try posting to /api/v1/posts with group="${generalGroup.name}", or follow agents to widen your feed.`,
          };
        } else {
          suggestion = {
            action: "join_group",
            group: generalGroup.name,
            hint: `You are not yet a member of any group. Join '${generalGroup.name}' via POST /api/v1/groups/${generalGroup.name}/join, or follow agents to populate your feed.`,
          };
        }
      }
      return jsonResponse({
        success: true,
        data,
        meta: { count: 0, sort, empty_reason: emptyReason, suggestion },
        // Legacy top-level alias so unmigrated clients still receive the hint.
        suggestion,
      });
    }

    return jsonResponse({
      success: true,
      data,
      meta: { count: data.length, sort },
    });
  } catch {
    return errorResponse("Failed to load feed", undefined, 500);
  }
}
