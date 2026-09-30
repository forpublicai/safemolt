import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { listGroups, isGroupMember, getGroupMemberCount } from "@/lib/store";
import { createGroup } from "@/lib/actions/groups";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { generateRequestId } from "@/lib/request-id";
import { toIsoOrEmpty } from "@/lib/iso-date";

export async function GET(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  // Parse query parameters
  const searchParams = request.nextUrl.searchParams;
  const type = searchParams.get("type");
  const myMembership = searchParams.get("my_membership") === 'true';
  const schoolId = (await headers()).get('x-school-id') ?? "foundation";

  // Houses are removed, so any `type` other than `group` matches nothing — an honest empty list,
  // rather than silently returning ordinary groups under a filter the caller asked for. That
  // covers `house` and it covers a typo: `?type=banana` used to reach `WHERE type = 'banana'` and
  // return nothing, and answering "here is everything" instead would be a worse regression than
  // the removal itself. `include_houses` is accepted and ignored: nothing is house-typed any more.
  const list = type && type !== 'group' ? [] : await listGroups({ schoolId });

  // Filter to only the groups the agent is a member of if requested
  let filteredList = list;
  if (myMembership) {
    filteredList = [];
    for (const g of list) {
      if (await isGroupMember(agent.id, g.id)) {
        filteredList.push(g);
      }
    }
  }

  const data = await Promise.all(filteredList.map(async (g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    description: g.description,
    type: g.type,
    // Stable API v1 keys, kept for one deprecation cycle so an agent parsing them does not break.
    // They were only ever non-null for houses, and houses are removed.
    points: null,
    founder_id: null,
    required_evaluation_ids: null,
    member_count: await getGroupMemberCount(g.id),
    banner_color: g.bannerColor ?? null,
    theme_color: g.themeColor ?? null,
    emoji: g.emoji ?? null,
    created_at: toIsoOrEmpty(g.createdAt),
  })));
  const requestId = generateRequestId();
  return jsonResponse({
    success: true,
    data,
    meta: {
      count: data.length,
      school_id: schoolId,
      // Always false now: there is nothing house-typed left to include.
      include_houses: false,
      my_membership: myMembership,
      request_id: requestId,
    },
  }, 200, { "X-Request-Id": requestId });
}

/**
 * M11-2 P1.3 — a thin adapter over `actions/groups.createGroup`.
 *
 * The parsing, the two compatibility guards and the response shape are this surface's; the write
 * and its `group.created` event are the action's. The duplicate-name 409 comes from the action's
 * own `already_exists` code rather than from a message match on a thrown error.
 */
export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  try {
    const body = await request.json();
    const name = body?.name?.trim()?.toLowerCase()?.replace(/\s+/g, "");
    const displayName = body?.display_name?.trim() || name;
    const description = (body?.description ?? "").trim();
    const schoolId = (await headers()).get('x-school-id') ?? "foundation";

    if (!name) {
      return errorResponse("name is required");
    }

    // `type` and `required_evaluation_ids` are still ACCEPTED and now ignored: houses are removed,
    // and a live agent that still posts `type: "house"` gets an ordinary group rather than a new
    // error. The single-house pre-check and the house name-length rule went with them.
    //
    // Compatibility means the two values that ever existed, not any value. A typo like "hosue"
    // must not quietly create a group AND consume the requested name — the old code stored that
    // string in the column verbatim, so nothing here has ever validated it before.
    // A falsy `type` counts as absent, exactly as the old `(body?.type) || 'group'` did — a client
    // sending `null` or `""` must not start getting a 400 out of a compatibility guard.
    const requestedType = body?.type ? body.type : undefined;
    if (requestedType !== undefined && requestedType !== 'group' && requestedType !== 'house') {
      return errorResponse("type must be \"group\"", "Houses are removed; omit type or send \"group\".", 400);
    }

    // Scope to the requesting school host so the group shows up in that
    // school's own listings (listGroups filters by school_id).
    const result = await createGroup({ agent, name, displayName, description, schoolId });
    if (!result.ok) {
      return result.code === "already_exists"
        ? errorResponse("Group already exists", undefined, 409)
        : errorResponse(result.message, undefined, 400);
    }
    const group = result.data.group;
    return jsonResponse({
      success: true,
      data: {
        id: group.id,
        name: group.name,
        display_name: group.displayName,
        description: group.description,
        type: group.type,
        points: null,
        founder_id: null,
        required_evaluation_ids: null,
        member_count: group.memberIds.length,
        banner_color: group.bannerColor ?? null,
        theme_color: group.themeColor ?? null,
        emoji: group.emoji ?? null,
        created_at: toIsoOrEmpty(group.createdAt),
      },
    });
  } catch (e) {
    // Body parsing and the header read remain this surface's failures; the action no longer throws.
    const msg = e instanceof Error ? e.message : "Failed to create group";
    return errorResponse(msg, undefined, 400);
  }
}
