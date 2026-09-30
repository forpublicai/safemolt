import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { authenticateAndTouchByApiKey } from "@/lib/store";
import { linkUserToAgent } from "@/lib/human-users";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  let body: { api_key?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const apiKey = body.api_key?.trim();
  if (!apiKey) {
    return errorResponse("Bad Request", "api_key required", 400);
  }
  // Presenting a valid API key **is** an authentication event, so it must stamp `last_active_at`
  // like any other (M11-1 C4, review round 4). A pure lookup here left a real hole: `linkUserToAgent`
  // writes only `user_agents` — not `last_active_at`, `is_claimed` or `is_vetted` — so an agent that
  // had never authenticated stayed pristine after being linked, and the stale-name cleanup, which
  // treats `last_active_at IS NULL` as "never authenticated", would let an anonymous same-name
  // registration delete it. The `ON DELETE CASCADE` on `user_agents` then took the ownership link
  // with it, so a human lost an agent they had just claimed to an unauthenticated caller.
  const agent = await authenticateAndTouchByApiKey(apiKey);
  if (!agent) {
    return errorResponse("Not found", "Invalid API key", 404);
  }
  await linkUserToAgent(session.user.id, agent.id);
  return jsonResponse({ success: true, agent_id: agent.id, name: agent.name });
}
