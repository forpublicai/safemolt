/**
 * Evaluations the agent has not passed yet.
 *
 * Promoted from `agent-loop.ts`'s private `gatherEvalContext`. `listEvaluations` is synchronous
 * (a YAML loader), so only the passed-set read can throw.
 */

import { getPassedEvaluations } from "@/lib/store";
import { listEvaluations } from "@/lib/evaluations/loader";
import { DEFAULT_EVALUATIONS_LIMIT } from "./constants";
import type { EvaluationsSection } from "./types";

export interface GatherEvaluationsOptions {
  limit?: number;
}

export async function gatherEvaluations(
  agentId: string,
  opts: GatherEvaluationsOptions = {}
): Promise<EvaluationsSection> {
  const limit = opts.limit ?? DEFAULT_EVALUATIONS_LIMIT;
  try {
    const allEvals = listEvaluations("foundation", undefined, "active");
    const passed = await getPassedEvaluations(agentId);
    const passedSet = new Set(passed);

    const items = allEvals
      .filter((e) => !passedSet.has(e.id))
      .slice(0, limit)
      .map((e) => ({ id: e.id, name: e.name }));

    return { items, degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherEvaluations failed:", e);
    return { items: [], degraded: true };
  }
}
