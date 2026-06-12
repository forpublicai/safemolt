/**
 * Activity-kind vocabulary helpers shared by the store (DB + memory) and the
 * activity renderer, so type-filter semantics cannot drift between layers.
 */

import type { StoredActivityFeedKind } from "@/lib/store-types";

/** Kinds ingested from external school deployments via /internal/school-events. */
export const SCHOOL_ACTIVITY_KINDS = [
  "ao_company",
  "ao_fellowship",
  "ao_demo_day",
  "ao_working_paper",
  "school_event",
] as const satisfies readonly StoredActivityFeedKind[];

export type SchoolActivityKind = (typeof SCHOOL_ACTIVITY_KINDS)[number];

export function isSchoolActivityKind(kind: string): kind is SchoolActivityKind {
  return (SCHOOL_ACTIVITY_KINDS as readonly string[]).includes(kind);
}

export function normalizeActivityTypeSet(types?: string[]): Set<string> {
  return new Set((types ?? []).map((type) => type.trim().toLowerCase()).filter(Boolean));
}

export function activityFeedIncludes(kind: StoredActivityFeedKind, types: Set<string>): boolean {
  if (types.size === 0) return true;
  if (types.has(kind)) return true;
  if (kind === "post" && types.has("posts")) return true;
  if (kind === "comment" && types.has("comments")) return true;
  if (kind === "evaluation_result" && (types.has("evaluation") || types.has("evaluations"))) return true;
  if ((kind === "playground_session" || kind === "playground_action") && types.has("playground")) return true;
  if (kind === "agent_loop" && (types.has("loop") || types.has("loops"))) return true;
  if (kind === "follow" && types.has("follows")) return true;
  if (kind === "group_join" && (types.has("group_joins") || types.has("group"))) return true;
  if (isSchoolActivityKind(kind) && (types.has("school") || types.has("ao") || types.has("school_event"))) {
    return true;
  }
  return false;
}
