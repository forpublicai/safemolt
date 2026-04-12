import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMemory } from "@/lib/memory/authorize";
import * as contextStore from "@/lib/memory/context-store";
import { normalizeContextPath } from "@/lib/memory/context-path";
import { deleteContextAndIndex, putContextAndMaybeIndex } from "@/lib/memory/memory-service";
import type { MemoryRequestContext } from "@/lib/memory/memory-service";

function ctxFromAuth(auth: import("@/lib/memory/authorize").AgentMemoryAuth): MemoryRequestContext {
  if (!auth.ok) return { sessionUserId: null };
  return { sessionUserId: auth.sessionUserId };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  const pathRaw = searchParams.get("path");
  if (!agentId || !pathRaw) {
    return errorResponse("Bad Request", "agent_id and path required", 400);
  }
  const path = normalizeContextPath(pathRaw);
  if (!path) return errorResponse("Bad Request", "invalid path", 400);
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const file = await contextStore.getContextFile(agentId, path);
  if (!file) return errorResponse("Not found", undefined, 404);
  return jsonResponse({
    success: true,
    path,
    content: file.content,
    updated_at: file.updatedAt,
  });
}

export async function PUT(request: Request) {
  let body: { agent_id?: string; path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const agentId = body.agent_id;
  const pathRaw = body.path;
  const content = typeof body.content === "string" ? body.content : "";
  if (!agentId || !pathRaw) {
    return errorResponse("Bad Request", "agent_id and path required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const res = await putContextAndMaybeIndex(agentId, pathRaw, content, ctxFromAuth(auth));
  if ("error" in res) {
    return errorResponse("Bad Request", res.error, 400);
  }
  return jsonResponse({ success: true, path: res.path });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agent_id");
  const pathRaw = searchParams.get("path");
  if (!agentId || !pathRaw) {
    return errorResponse("Bad Request", "agent_id and path required", 400);
  }
  const auth = await authorizeAgentMemory(request, agentId);
  if (!auth.ok) {
    if (auth.reason === "unauthorized") return errorResponse("Unauthorized", undefined, 401);
    return errorResponse("Forbidden", undefined, 403);
  }
  const res = await deleteContextAndIndex(agentId, pathRaw, ctxFromAuth(auth));
  if (!res.ok) {
    return errorResponse("Bad Request", res.error ?? "invalid path", 400);
  }
  return jsonResponse({ success: true });
}
