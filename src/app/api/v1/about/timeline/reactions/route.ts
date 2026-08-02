import { auth } from "@/auth";
import { requireAgent, optionalAgent, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getAboutTimelineFullReactionState,
  getAboutTimelineReactionRowState,
  toggleAboutTimelineReaction,
} from "@/lib/store";
import {
  isValidAboutTimelineRowKey,
  validateReactionEmoji,
} from "@/lib/about-timeline-reactions";
import { NextRequest } from "next/server";

async function resolveViewer(request: NextRequest): Promise<
  { kind: "agent" | "human"; id: string } | null
> {
  const { agent } = await optionalAgent(request);
  if (agent) return { kind: "agent", id: agent.id };
  const session = await auth();
  if (session?.user?.id) {
    return { kind: "human", id: session.user.id as string };
  }
  return null;
}

/** GET: full timeline reaction state, or one row if ?row_key= */
export async function GET(request: NextRequest) {
  const viewer = await resolveViewer(request);
  const rowKey = request.nextUrl.searchParams.get("row_key");
  if (rowKey) {
    if (!isValidAboutTimelineRowKey(rowKey)) {
      return errorResponse("Bad request", "invalid row_key", 400);
    }
    const row = await getAboutTimelineReactionRowState(rowKey, viewer);
    return jsonResponse({
      success: true,
      data: { row_key: rowKey, row },
    });
  }
  const full = await getAboutTimelineFullReactionState(viewer);
  return jsonResponse({ success: true, data: full });
}

/**
 * Resolve the principal allowed to *write* a reaction.
 *
 * Two principals, judged separately (M11-1 C20, same split as `resolveAgentMemoryAuth`): an agent
 * bearer must satisfy the platform access rule, while a Cognito owner is not an agent and must not
 * be judged as one. Branching on the presence of a bearer rather than on whether it resolved keeps
 * a rejected agent from silently falling through to the human branch.
 */
async function resolveWriteViewer(request: NextRequest): Promise<
  | { ok: true; viewer: { kind: "agent" | "human"; id: string } }
  | { ok: false; response: Response }
> {
  if (request.headers.get("Authorization")?.startsWith("Bearer ")) {
    const access = await requireAgent(request);
    if (!access.ok) return { ok: false, response: access.response };
    return { ok: true, viewer: { kind: "agent", id: access.agent.id } };
  }

  const session = await auth();
  if (session?.user?.id) {
    return { ok: true, viewer: { kind: "human", id: session.user.id as string } };
  }

  return {
    ok: false,
    response: errorResponse("Unauthorized", "Sign in or send Authorization: Bearer <api_key>", 401),
  };
}

/** POST: toggle emoji on a row (Bearer agent or human session) */
export async function POST(request: NextRequest) {
  const resolved = await resolveWriteViewer(request);
  if (!resolved.ok) return resolved.response;
  const viewer = resolved.viewer;

  let body: { row_key?: string; emoji?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const rowKey = typeof body.row_key === "string" ? body.row_key.trim() : "";
  const emoji = typeof body.emoji === "string" ? body.emoji : "";
  if (!isValidAboutTimelineRowKey(rowKey)) {
    return errorResponse("Bad request", "invalid row_key", 400);
  }
  if (!validateReactionEmoji(emoji)) {
    return errorResponse("Bad request", "invalid emoji", 400);
  }

  try {
    const action = await toggleAboutTimelineReaction(rowKey, emoji, viewer);
    const row = await getAboutTimelineReactionRowState(rowKey, viewer);
    return jsonResponse({
      success: true,
      action,
      row_key: rowKey,
      row,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "toggle failed";
    return errorResponse("Bad request", msg, 400);
  }
}
