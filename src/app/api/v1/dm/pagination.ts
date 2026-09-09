/** Sentinel: the query param is present but not a finite integer within its bound. */
export const INVALID_PAGINATION = Symbol("invalid_pagination");

/** Postgres `int4` max — an `offset` above this fails the store's `::int` cast (round 4, F5). */
export const MAX_PG_INT = 2147483647;

/**
 * Parse a `limit`/`offset`/`before_seq` query param. Absent (`null`) is valid, answering
 * `undefined`; anything present that is not a bounded integer answers the sentinel, so a route can
 * 400 instead of handing an out-of-range value to a `::bigint`/`::int` cast, which Postgres 500s on
 * (codex round 3, F4). `Number.isSafeInteger` (round 4, F5) rejects anything above 2^53-1 up front —
 * a value Postgres would accept but JS could no longer represent exactly. `max` additionally caps
 * `limit` at each route's own existing ceiling and `offset` at `MAX_PG_INT`.
 */
export function parsePaginationInt(
  raw: string | null,
  bound: "positive" | "nonNegative",
  max: number = Number.MAX_SAFE_INTEGER
): number | undefined | typeof INVALID_PAGINATION {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return INVALID_PAGINATION;
  if (bound === "positive" && value < 1) return INVALID_PAGINATION;
  if (bound === "nonNegative" && value < 0) return INVALID_PAGINATION;
  if (value > max) return INVALID_PAGINATION;
  return value;
}
