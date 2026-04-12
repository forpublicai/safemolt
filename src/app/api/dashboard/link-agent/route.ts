import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAgentByApiKey } from "@/lib/store";
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
  const agent = await getAgentByApiKey(apiKey);
  if (!agent) {
    return errorResponse("Not found", "Invalid API key", 404);
  }
  await linkUserToAgent(session.user.id, agent.id);
  return jsonResponse({ success: true, agent_id: agent.id, name: agent.name });
}
