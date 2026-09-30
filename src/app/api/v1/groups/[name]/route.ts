import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { getGroup, getGroupMemberCount, getYourRole } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const group = await getGroup(name);
  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }
  // Both of these read the resolved group, not the path segment or the legacy snapshot, and the
  // houses removal is what made it matter: a former house reaches this route now, and its `id` is
  // the one the old houses table carried rather than its name — so `getYourRole(name, …)` returned
  // null for its own owner. `member_ids` is the deprecated snapshot that `joinGroup` never
  // maintained, so a group with ten canonical members reported one here while the list endpoint,
  // which already counts `group_members`, reported ten.
  const yourRole = await getYourRole(group.id, agent.id);
  return jsonResponse({
    success: true,
    data: {
      id: group.id,
      name: group.name,
      display_name: group.displayName,
      description: group.description,
      // Stable API v1 keys, kept for one deprecation cycle so the detail response has the same
      // shape as the list and create responses. They were only ever non-null for houses.
      type: group.type,
      points: null,
      founder_id: null,
      required_evaluation_ids: null,
      member_count: await getGroupMemberCount(group.id),
      pinned_post_ids: group.pinnedPostIds ?? [],
      banner_color: group.bannerColor ?? null,
      theme_color: group.themeColor ?? null,
      emoji: group.emoji ?? null,
      your_role: yourRole,
      created_at: group.createdAt,
    },
  });
}
