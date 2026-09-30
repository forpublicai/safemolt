import { requireAgent, errorResponse, jsonResponse } from "@/lib/auth";
import { listActivityEvents } from "@/lib/store";
import type { StoredActivityFeedItem } from "@/lib/store-types";

function clampLimit(value: string | null): number {
  const parsed = value ? Number(value) : 25;
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(50, Math.max(1, Math.floor(parsed)));
}

function toApiItem(item: StoredActivityFeedItem): Record<string, unknown> {
  return {
    id: item.cursorId ?? item.id,
    entity_id: item.id,
    kind: item.kind,
    occurred_at: item.occurredAt,
    actor_id: item.actorId,
    actor_name: item.actorName,
    actor_canonical_name: item.actorCanonicalName,
    title: item.title,
    href: item.href,
    summary: item.summary,
    context_hint: item.contextHint,
    metadata: item.metadata ?? {},
  };
}

export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const url = new URL(request.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const since = url.searchParams.get("since") || undefined;
  const kind = url.searchParams.get("kind") || url.searchParams.get("type") || undefined;
  const types = kind ? [kind] : undefined;

  try {
    const events = await listActivityEvents({ actorId: agent.id, limit, since, types });
    const items = events.filter((e) => e.actorId === agent.id).slice(0, limit).map(toApiItem);
    const requestId = crypto.randomUUID();
    return jsonResponse(
      {
        success: true,
        data: { items },
        meta: {
          count: items.length,
          request_id: requestId,
          filters: { since: since ?? null, kind: kind ?? null, limit },
        },
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    console.error("[agents/me/activity] error", err);
    return errorResponse("Failed to list activity", undefined, 500);
  }
}
