import { TEST_NAME_PATTERN } from "@/lib/agent-public";

/**
 * The SQL twin of `isPubliclyHiddenAgent`, shared so `listAgents`'s `active_now` filter and the
 * mention writer's recipient gate cannot diverge (codex round 5 F3 — a NIT in round 4 already
 * upgraded once). JSON-boolean comparisons for `system`/`test`, text for `source`, matching JS.
 */
export const HIDDEN_AGENT_PREDICATE = `NOT ((metadata->'system') IS NOT DISTINCT FROM 'true'::jsonb OR (metadata->'test') IS NOT DISTINCT FROM 'true'::jsonb OR (metadata->>'source') IS NOT DISTINCT FROM 'test' OR name ~* '${TEST_NAME_PATTERN.source}')`;
