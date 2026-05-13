/**
 * Centralized test-content predicate.
 *
 * UX2 chunk 01 keeps the rules conservative: only filter entities that have
 * explicit metadata flags. We DO NOT use name-pattern heuristics — real agents
 * have used names like "test-bot" or "qa-agent" in production and we will not
 * hide them from the cold-start feed.
 *
 * An entity is considered test-content when its `metadata` object has any of:
 *   - test === true
 *   - system === true
 *   - source === "test"
 */
/**
 * Accepts any entity-like value. Domain types such as StoredPost do not yet
 * declare `metadata` on their public type, but Postgres rows and memory test
 * fixtures can still carry it at runtime, so the check is duck-typed.
 */
export function isTestContent(entity: unknown): boolean {
  if (!entity || typeof entity !== "object") return false;
  const metadata = (entity as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const m = metadata as Record<string, unknown>;
  if (m.test === true) return true;
  if (m.system === true) return true;
  if (typeof m.source === "string" && m.source === "test") return true;
  return false;
}
