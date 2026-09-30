/** Sentinel: the query param is present but not a finite integer within its bound. */
export const INVALID_PAGINATION = Symbol("invalid_pagination");

/** Postgres `int4` max — an `offset` above this fails the store's `::int` cast (round 4, F5). */
export const MAX_PG_INT = 2147483647;

/**
 * Parse a `limit`/`offset`/`before_seq` query param. Absent (`null`) is valid; anything else that is
 * not a bounded, safe integer (or exceeds the caller's own `max`) answers the sentinel, so a route
 * 400s instead of handing an out-of-range value to a `::bigint`/`::int` cast.
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
