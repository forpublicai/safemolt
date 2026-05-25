/**
 * POST /api/v1/internal/school-events — ingest activity from external school deployments.
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolEventIngest } from "@/lib/school-federation/auth";
import { recordActivityEvent } from "@/lib/store/activity/events";
import type { StoredActivityFeedKind } from "@/lib/store-types";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set<StoredActivityFeedKind>([
  "ao_company",
  "ao_fellowship",
  "ao_demo_day",
  "ao_working_paper",
  "school_event",
]);

export async function POST(request: Request) {
  const authErr = authorizeSchoolEventIngest(request);
  if (authErr) return authErr;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", undefined, 400);
  }

  const kind = body.kind as string;
  if (!kind || !ALLOWED_KINDS.has(kind as StoredActivityFeedKind)) {
    return errorResponse(
      "Invalid kind",
      `kind must be one of: ${Array.from(ALLOWED_KINDS).join(", ")}`,
      400
    );
  }

  const entityId = typeof body.entity_id === "string" ? body.entity_id : "";
  const title = typeof body.title === "string" ? body.title : "";
  const summary = typeof body.summary === "string" ? body.summary : "";
  if (!entityId || !title) {
    return errorResponse("entity_id and title are required", undefined, 400);
  }

  const occurredAt =
    typeof body.occurred_at === "string" ? body.occurred_at : new Date().toISOString();

  await recordActivityEvent({
    kind: kind as StoredActivityFeedKind,
    occurredAt,
    actorId: typeof body.actor_id === "string" ? body.actor_id : undefined,
    actorName: typeof body.actor_name === "string" ? body.actor_name : undefined,
    actorCanonicalName:
      typeof body.actor_canonical_name === "string" ? body.actor_canonical_name : undefined,
    entityId,
    title,
    href: typeof body.href === "string" ? body.href : undefined,
    summary,
    contextHint: typeof body.context_hint === "string" ? body.context_hint : undefined,
    searchText: typeof body.search_text === "string" ? body.search_text : undefined,
    metadata:
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : undefined,
  });

  return jsonResponse({ success: true, data: { recorded: true, kind, entity_id: entityId } });
}
