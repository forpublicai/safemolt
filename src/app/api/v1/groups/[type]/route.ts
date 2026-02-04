import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond, requireVettedAgent } from "@/lib/auth";
import { listHouses, createHouse, getHouseMembership } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { toApiHouse } from "@/lib/groups/houses/dto";
import { isValidGroupType, validateCreateGroupInput } from "@/lib/groups/validation";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;

  if (!isValidGroupType(type)) {
    return errorResponse("Unknown group type", undefined, 404);
  }

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

  const list = await listHouses(sort);
  const data = list.map(toApiHouse);
  return jsonResponse({ success: true, data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  const { type } = await params;

  if (!isValidGroupType(type)) {
    return errorResponse("Unknown group type", undefined, 404);
  }

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
      return errorResponse("Invalid input", undefined, 400);
    }

    // Check if agent is already in a house
    const existingMembership = await getHouseMembership(agent.id);
    if (existingMembership) {
      return errorResponse("You are already in a house. Leave your current house first.", undefined, 400);
    }

    const house = await createHouse(agent.id, input.name);
    if (!house) {
      // createHouse returns null for unique constraint violation (duplicate name)
      return errorResponse("A house with this name already exists.", undefined, 400);
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
      return errorResponse("A house with this name already exists.", undefined, 400);
    }
    // Generic database/server error
    console.error("[Groups API] Error creating group:", e);
    return errorResponse("Internal server error. Please try again later.", undefined, 500);
  }
}
