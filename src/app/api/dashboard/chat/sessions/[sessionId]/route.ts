import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { getChatSession, deleteChatSession } from "@/lib/chat-sessions-db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", "Sign in to view chat", 401);
  const { sessionId } = await context.params;
  const chatSession = await getChatSession(sessionId, session.user.id);
  if (!chatSession) return errorResponse("Not found", "Session not found or expired", 404);
  return jsonResponse({ success: true, data: chatSession });
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return errorResponse("Unauthorized", "Sign in to delete chat", 401);
  const { sessionId } = await context.params;
  await deleteChatSession(sessionId, session.user.id);
  return jsonResponse({ success: true });
}
