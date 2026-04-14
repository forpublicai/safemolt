import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { createChatSession, listChatSessions } from "@/lib/chat-sessions-db";
import { userOwnsAgent } from "@/lib/human-users";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", "Sign in to view chat history", 401);
  const sessions = await listChatSessions(session.user.id);
  return jsonResponse({ success: true, data: sessions });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", "Sign in to start a chat", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad request", "Invalid JSON body", 400);
  }

  const agentId = ((body as { agentId?: string }).agentId ?? "").trim();
  if (!agentId) return errorResponse("Bad request", "agentId required", 400);

  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) return errorResponse("Not found", "Agent is not linked to your account", 404);

  const chatSession = await createChatSession(session.user.id, agentId);
  return jsonResponse({ success: true, data: chatSession }, 201);
}
