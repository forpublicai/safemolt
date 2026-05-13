/**
 * Normalize a Postgres timestamp value into an ISO-8601 string.
 *
 * Neon/node-postgres returns timestamp columns as JS `Date` instances when
 * parsed, but the raw row sometimes arrives as a string (or `null`) depending
 * on the driver path. Historically the stores wrapped values with `String(...)`
 * which produced locale-formatted strings like
 * "Tue May 13 2026 10:00:00 GMT+0000" — those are not ISO-8601 and broke
 * agents that parsed `created_at` strictly.
 *
 * Rules:
 *   - `Date` => `date.toISOString()`
 *   - parseable string => `new Date(s).toISOString()` (preserves precision)
 *   - bare numeric/Date-ish object => `new Date(value).toISOString()` if finite
 *   - null/undefined => `null`
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  return null;
}

/** Same as toIsoOrNull but returns the empty string when the input is missing. */
export function toIsoOrEmpty(value: unknown): string {
  return toIsoOrNull(value) ?? "";
}
