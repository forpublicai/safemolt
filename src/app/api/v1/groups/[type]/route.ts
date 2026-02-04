import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { GroupStoreRegistry } from "@/lib/groups/registry";
import { GroupType } from "@/lib/groups/types";
import type { IHouseStore } from "@/lib/groups/houses/store";
import { toApiHouse } from "@/lib/groups/houses/dto";
import { isValidGroupType, validateCreateGroupInput } from "@/lib/groups/validation";
import { defaultSecurityLogger } from "@/lib/security-logger";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;

  if (!isValidGroupType(type)) {
    defaultSecurityLogger.validationFailure(
      request.url,
      'unsupported_group_type',
      { type }
    );
    return errorResponse("Unknown group type", undefined, 404);
  }

  const store = GroupStoreRegistry.getHandler(type as GroupType);
  if (!store) {
    defaultSecurityLogger.validationFailure(
      request.url,
      'unsupported_group_type',
      { type }
    );
    return errorResponse("Group type not supported", undefined, 404);
  }

  // Type narrowing for houses
  if (type === GroupType.HOUSES) {
    const houseStore = store as IHouseStore;

    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
    }
    const vettingResponse = requireVettedAgent(agent, `/api/v1/groups/${type}`);
    if (vettingResponse) return vettingResponse;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);
    const sortParam = url.searchParams.get("sort");
    const validSorts = ["points", "recent", "name"] as const;
    const sort = validSorts.includes(sortParam as typeof validSorts[number])
      ? (sortParam as typeof validSorts[number])
      : "points";

    const list = await houseStore.listHouses(sort);
    const data = list.map(toApiHouse);
    return jsonResponse({ success: true, data });
  }

  // Unsupported group type
  defaultSecurityLogger.validationFailure(
    request.url,
    'unsupported_group_type',
    { type }
  );
  return errorResponse("Group type not supported", undefined, 404);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;

  if (!isValidGroupType(type)) {
    defaultSecurityLogger.validationFailure(
      request.nextUrl.pathname,
      'unsupported_group_type',
      { type }
    );
    return errorResponse("Unknown group type", undefined, 404);
  }

  const store = GroupStoreRegistry.getHandler(type as GroupType);
  if (!store) {
    defaultSecurityLogger.validationFailure(
      request.nextUrl.pathname,
      'unsupported_group_type',
      { type }
    );
    return errorResponse("Group type not supported", undefined, 404);
  }

  // Type narrowing for houses
  if (type === GroupType.HOUSES) {
    const houseStore = store as IHouseStore;

    const agent = await getAgentFromRequest(request);
    if (!agent) {
      return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
    }
    const vettingResponse = requireVettedAgent(agent, request.nextUrl.pathname);
    if (vettingResponse) return vettingResponse;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;

    try {
      const body = await request.json();
      const input = validateCreateGroupInput(body);
      if (!input) {
        defaultSecurityLogger.validationFailure(
          request.nextUrl.pathname,
          'invalid_input',
          { field: 'name', reason: 'missing_or_invalid' }
        );
        return errorResponse("Invalid input", undefined, 400);
      }

      // Check if agent is already in a house
      const existingMembership = await houseStore.getHouseMembership(agent.id);
      if (existingMembership) {
        defaultSecurityLogger.validationFailure(
          request.nextUrl.pathname,
          'already_in_group',
          { agent_id: agent.id }
        );
        return errorResponse("You are already in a house. Leave your current house first.", undefined, 400);
      }

      const group = await houseStore.createGroup(type as GroupType, agent.id, { name: input.name });
      if (!group) {
        // createGroup returns null for unique constraint violation (duplicate name)
        defaultSecurityLogger.validationFailure(
          request.nextUrl.pathname,
          'duplicate_group_name',
          { name: input.name }
        );
        return errorResponse("A house with this name already exists.", undefined, 400);
      }

      // Get the full house data with points
      const house = await houseStore.getHouse(group.id);
      if (!house) {
        defaultSecurityLogger.validationFailure(
          request.nextUrl.pathname,
          'group_not_found_after_creation',
          { group_id: group.id }
        );
        return errorResponse("Internal server error. Please try again later.", undefined, 500);
      }

      return jsonResponse({
        success: true,
        data: toApiHouse(house),
      });
    } catch (e) {
      // Check for PostgreSQL unique constraint violation (code 23505)
      const isUniqueViolation =
        e && typeof e === "object" && "code" in e && e.code === "23505";
      if (isUniqueViolation) {
        defaultSecurityLogger.validationFailure(
          request.nextUrl.pathname,
          'duplicate_group_name',
          { error: 'unique_constraint_violation' }
        );
        return errorResponse("A house with this name already exists.", undefined, 400);
      }
      // Generic database/server error
      defaultSecurityLogger.validationFailure(
        request.nextUrl.pathname,
        'group_creation_failed',
        { error: e instanceof Error ? e.message : 'Unknown error' }
      );
      return errorResponse("Internal server error. Please try again later.", undefined, 500);
    }
  }

  // Unsupported group type
  defaultSecurityLogger.validationFailure(
    request.nextUrl.pathname,
    'unsupported_group_type',
    { type }
  );
  return errorResponse("Group type not supported", undefined, 404);
}
