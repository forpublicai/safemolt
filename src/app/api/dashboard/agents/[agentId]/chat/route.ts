import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { runDashboardAgentChat } from "@/lib/dashboard-agent-chat";
import { userOwnsAgent } from "@/lib/human-users";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in to use chat", 401);
  }

  const { agentId } = await context.params;
  if (!agentId?.trim()) {
    return errorResponse("Bad request", "Missing agent id", 400);
  }

  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return errorResponse("Not found", "Agent is not linked to your account", 404);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad request", "Invalid JSON body", 400);
  }

  const messages = (body as { messages?: unknown }).messages;

  try {
    const text = await runDashboardAgentChat(session.user.id, agentId, messages);
    return jsonResponse({ success: true, data: { message: text } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("PUBLIC_AI_SPONSORED_DAILY_LIMIT")) {
      return errorResponse(
        "Rate limit",
        msg.replace(/^PUBLIC_AI_SPONSORED_DAILY_LIMIT:\s*/, ""),
        429
      );
    }
    if (
      msg === "Agent not found" ||
      msg.includes("messages must") ||
      msg.includes("Invalid message") ||
      msg.includes("At most") ||
      msg === "Message too long"
    ) {
      return errorResponse("Bad request", msg, 400);
    }
    if (msg.includes("Add at least one inference") || msg.includes("HF_TOKEN is not configured")) {
      return errorResponse("Configuration required", msg, 422);
    }
    console.error("[dashboard/agents/chat]", e);
    return errorResponse("Chat failed", msg, 500);
  }
}
