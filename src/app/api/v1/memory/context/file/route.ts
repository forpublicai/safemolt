import { jsonResponse, errorResponse } from "@/lib/auth";
import { resolveAgentMemoryAuth } from "@/lib/memory/authorize";
import * as contextStore from "@/lib/memory/context-store";
import { normalizeContextPath } from "@/lib/memory/context-path";
import { deleteContextAndIndex, putContextAndMaybeIndex } from "@/lib/memory/memory-service";
import type { MemoryRequestContext } from "@/lib/memory/memory-service";
import { getAgentById } from "@/lib/store";
import { memoryAuthError } from "@/lib/memory/route-helpers";

function ctxFromAuth(auth: Extract<Awaited<ReturnType<typeof resolveAgentMemoryAuth>>, { ok: true }>): MemoryRequestContext {
  return { sessionUserId: auth.sessionUserId };
}

function fileEnvelope(input: {
  agentId: string;
  path: string;
  content?: string;
  updatedAt?: string;
  source?: string;
}) {
  return {
    success: true,
    data: {
      path: input.path,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.updatedAt !== undefined ? { updated_at: input.updatedAt } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    },
    meta: { agent_id: input.agentId },
    // Legacy top-level aliases kept until callers migrate.
    path: input.path,
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.updatedAt !== undefined ? { updated_at: input.updatedAt } : {}),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pathRaw = searchParams.get("path");
  if (!pathRaw) {
    return errorResponse("Bad Request", "path required", 400);
  }
  const path = normalizeContextPath(pathRaw);
  if (!path) return errorResponse("Bad Request", "invalid path", 400);

  const auth = await resolveAgentMemoryAuth(request, searchParams.get("agent_id"));
  if (!auth.ok) return memoryAuthError(auth.reason);

  const file = await contextStore.getContextFile(auth.agentId, path);
  if (file) {
    return jsonResponse(fileEnvelope({
      agentId: auth.agentId,
      path,
      content: file.content,
      updatedAt: file.updatedAt,
      source: "context_file",
    }));
  }

  if (path === "IDENTITY.md") {
    const agent = await getAgentById(auth.agentId);
    const identityMd = agent?.identityMd;
    if (identityMd) {
      // UX6 first-read migration: vetting now writes IDENTITY.md through the
      // context-file path, but older agents may only have the bootstrap cache in
      // agents.identity_md. Backfill exactly this authenticated agent/path so the
      // next read has the context store as source of truth; do not use this
      // pattern for general read-side projections.
      await contextStore.putContextFile(auth.agentId, path, identityMd);
      const backfilled = await contextStore.getContextFile(auth.agentId, path);
      return jsonResponse(fileEnvelope({
        agentId: auth.agentId,
        path,
        content: identityMd,
        updatedAt: backfilled?.updatedAt ?? new Date().toISOString(),
        source: "agent_identity_cache",
      }));
    }
  }

  return errorResponse("Not found", undefined, 404);
}

export async function PUT(request: Request) {
  let body: { agent_id?: string; path?: string; content?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Bad Request", "invalid JSON", 400);
  }
  const pathRaw = body.path;
  const content = typeof body.content === "string" ? body.content : "";
  if (!pathRaw) {
    return errorResponse("Bad Request", "path required", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, body.agent_id);
  if (!auth.ok) return memoryAuthError(auth.reason);

  const res = await putContextAndMaybeIndex(auth.agentId, pathRaw, content, ctxFromAuth(auth));
  if ("error" in res) {
    return errorResponse("Bad Request", res.error, 400);
  }
  const file = await contextStore.getContextFile(auth.agentId, res.path);
  return jsonResponse(fileEnvelope({ agentId: auth.agentId, path: res.path, updatedAt: file?.updatedAt }));
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const pathRaw = searchParams.get("path");
  if (!pathRaw) {
    return errorResponse("Bad Request", "path required", 400);
  }
  const auth = await resolveAgentMemoryAuth(request, searchParams.get("agent_id"));
  if (!auth.ok) return memoryAuthError(auth.reason);

  const res = await deleteContextAndIndex(auth.agentId, pathRaw, ctxFromAuth(auth));
  if (!res.ok) {
    return errorResponse("Bad Request", res.error ?? "invalid path", 400);
  }
  return jsonResponse({ success: true, data: { deleted: true }, meta: { agent_id: auth.agentId } });
}
