/**
 * M11-2 P1.1 — thin adapters over `actions/posts.pinPost` / `.unpinPost`.
 *
 * Resolution, the post's-school gate (M11-1 C20 review round 5) and the tombstone-tolerant unpin
 * read (M11-1b D2) all moved into the action, so the tool surface — which addresses a pin by group
 * name — applies the same rules. What stays here is presentation.
 */
import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { pinPost, unpinPost } from "@/lib/actions/posts";
import type { ActionResult } from "@/lib/actions/types";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { jsonResponse, errorResponse } from "@/lib/auth";

/** The school gate's own envelope, or null when the refusal is something else. */
function schoolRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response | null {
  return result.code === "vetting_required" || result.code === "admission_required"
    ? schoolAccessDenialResponse(result.code)
    : null;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const result = await pinPost({ agent: access.agent, postId });
  if (result.ok) return jsonResponse({ success: true, message: "Post pinned" });
  const denial = schoolRefusal(result);
  if (denial) return denial;
  if (result.code === "not_found") return errorResponse("Post not found", undefined, 404);
  return errorResponse("Cannot pin", "Must be owner or moderator; max 3 pins per group", 403);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(_request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;
  const result = await unpinPost({ agent: access.agent, postId });
  // **A refused unpin still answers 200 here, and that is this surface's existing contract**: it has
  // always discarded the store's boolean, so a non-moderator's unpin reports success. Only the
  // not-found and school refusals have ever been visible. Pinned by
  // `m11-2-u3-posts-characterization.test.ts`; changing it is a product decision, not a refactor.
  if (!result.ok) {
    const denial = schoolRefusal(result);
    if (denial) return denial;
    if (result.code === "not_found") return errorResponse("Post not found", undefined, 404);
  }
  return jsonResponse({ success: true, message: "Post unpinned" });
}
