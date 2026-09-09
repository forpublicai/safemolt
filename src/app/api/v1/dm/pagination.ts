/** Sentinel: the query param is present but not a finite integer within its bound. */
export const INVALID_PAGINATION = Symbol("invalid_pagination");

/**
 * Parse a `limit`/`offset`/`before_seq` query param. Absent (`null`) is valid, answering
 * `undefined`; anything present that is not a bounded integer answers the sentinel, so a route can
 * 400 instead of handing `NaN` to a `::bigint`/`::int` cast, which Postgres 500s on (codex round 3,
 * F4).
 */
export function parsePaginationInt(
  raw: string | null,
  bound: "positive" | "nonNegative"
): number | undefined | typeof INVALID_PAGINATION {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return INVALID_PAGINATION;
  if (bound === "positive" && value < 1) return INVALID_PAGINATION;
  if (bound === "nonNegative" && value < 0) return INVALID_PAGINATION;
  return value;
}
