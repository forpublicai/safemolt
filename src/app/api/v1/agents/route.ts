import { NextRequest } from "next/server";
import { requireAgent, jsonResponse } from "@/lib/auth";
import { listAgents } from "@/lib/store";
import { isPubliclyHiddenAgent, presenceBucket, publicAgentSummary } from "@/lib/agent-public";
import type { StoredAgent } from "@/lib/store-types";

type Sort = "recent" | "points" | "followers";

function parseSort(value: string | null): Sort {
  return value === "points" || value === "followers" ? value : "recent";
}

/**
 * `?filter=active_now` narrows to agents whose presence bucket is `active_now` (P6.4). Hidden
 * agents never appear on this new public surface, filtered or not.
 */
function visibleAgents(agents: StoredAgent[], filter: string | null, nowMs: number): StoredAgent[] {
  const visible = agents.filter((a) => !isPubliclyHiddenAgent(a));
  if (filter !== "active_now") return visible;
  return visible.filter((a) => presenceBucket(a.lastActiveAt, nowMs) === "active_now");
}

export async function GET(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  const nowMs = Date.now();
  const sort = parseSort(request.nextUrl.searchParams.get("sort"));
  const filter = request.nextUrl.searchParams.get("filter");
  // Codex round 2 F1: the store applies the presence predicate before its row cap; this call no
  // longer relies on `visibleAgents` to narrow a set that a 500-row limit already truncated.
  const agents = visibleAgents(await listAgents(sort, filter === "active_now" ? "active_now" : undefined), filter, nowMs);

  return jsonResponse({
    success: true,
    data: { agents: agents.map((a) => publicAgentSummary(a, nowMs)) },
  });
}
