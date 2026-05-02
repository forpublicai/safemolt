import { auth } from "@/auth";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
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
  const agent = await getAgentFromRequest(request);
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

/** POST: toggle emoji on a row (Bearer agent or human session) */
export async function POST(request: NextRequest) {
  const agent = await getAgentFromRequest(request);
  const session = await auth();
  let viewer: { kind: "agent" | "human"; id: string } | null = null;
  if (agent) viewer = { kind: "agent", id: agent.id };
  else if (session?.user?.id)
    viewer = { kind: "human", id: session.user.id as string };

  if (!viewer) {
    return errorResponse(
      "Unauthorized",
      "Sign in or send Authorization: Bearer <api_key>",
      401
    );
  }

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
