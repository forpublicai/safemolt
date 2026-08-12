/**
 * The ingest audience's ordering and cap, in one place.
 *
 * **A leaf module on purpose.** The audience `post.deleted` pins into its event payload has to be the
 * same list `collectAgentIdsForPostAudience` computes, because the cap decides *who is dropped* and a
 * deletion that cleaned a differently-truncated set than the ingest wrote would leave vectors behind.
 * `platform-ingest.ts` imports `@/lib/store`, so the store cannot import it back; this file imports
 * nothing, and every TypeScript path — the ingest fan-out and the memory store's deletion payload —
 * derives the audience through `orderAndCapPostAudience` below. The db store's SQL is the one
 * derivation that cannot share this code, and it is parity-tested against it.
 */

/** The default fan-out cap when the env knob is unset or unusable. */
export const DEFAULT_MEMORY_INGEST_MAX_FANOUT = 2000;

/**
 * The largest cap the cap can be, and it is a **Postgres** limit rather than a product one.
 *
 * `post.deleted`'s audience CTE ends in `LIMIT $n::int`, so the value crosses into a 32-bit signed
 * integer. A knob set above that range raises `22003 integer out of range` — and because the cap is
 * bound into the deleting batch, *every* post deletion would fail, platform-wide, from one env
 * typo. Clamping here rather than in the SQL keeps both stores reading the same number: memory
 * truncates its array with the same value, and a divergence there is a differently-cleaned audience.
 */
export const MAX_MEMORY_INGEST_FANOUT = 2_147_483_647;

export function memoryIngestFanoutCap(): number {
  const configured = process.env.MEMORY_INGEST_MAX_FANOUT;
  if (configured === undefined || configured === "") return DEFAULT_MEMORY_INGEST_MAX_FANOUT;
  const parsed = parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MEMORY_INGEST_MAX_FANOUT;
  // Clamped, not refused: a cap larger than the biggest audience Postgres can express is simply
  // "no cap", and turning it into a startup failure would be a worse answer than honouring it.
  return Math.min(parsed, MAX_MEMORY_INGEST_FANOUT);
}

/**
 * A post's audience, in the stable priority order, deduplicated first-occurrence-wins, then capped.
 *
 * **The order is a property of the data, never of the plan.** The cap truncates, so any wobble in the
 * sequence — a different scan order from Postgres, a different JSONB array order after a membership
 * edit — silently changes which recipients are ingested. Two passes over one event would then produce
 * different effect-key sets and a fan-out would never converge on the same audience twice.
 *
 * The order is: the AUTHOR first (never dropped — it is their own content), then the group's members
 * sorted by id, then the author's followers sorted by id. Sorting happens here rather than at the
 * call sites, so the guarantee does not depend on a caller remembering which store it read from.
 *
 * @param authorId the post's author.
 * @param memberIds the group's members, in any order.
 * @param followerIds the author's followers, in any order.
 */
export function orderAndCapPostAudience(
  authorId: string,
  memberIds: readonly string[],
  followerIds: readonly string[]
): string[] {
  const ordered = new Set<string>([authorId]);
  // `Set` keeps the first occurrence, so a member who also follows appears once, in the member
  // position — which is what the db store's `DISTINCT ON (agent_id) … ORDER BY bucket` reproduces.
  for (const id of [...memberIds].sort()) ordered.add(id);
  for (const id of [...followerIds].sort()) ordered.add(id);
  const cap = memoryIngestFanoutCap();
  const all = Array.from(ordered);
  return all.length <= cap ? all : all.slice(0, cap);
}
