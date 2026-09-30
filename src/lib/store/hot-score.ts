/**
 * Hot score with signed decay (M11-2 P6.5). Positive raw scores decay toward zero with age;
 * non-positive scores are NOT divided by the age term — dividing a negative by a growing
 * denominator would float an old, heavily-downvoted post above a fresh, mildly-negative one.
 * `$now` is always a caller-bound parameter so SQL and the TS twin share one clock.
 */

/** Raw SQL for `ORDER BY`. `nowPlaceholder` is the caller's own `$N` for `now`; `colPrefix` is an
 * optional table alias (e.g. `"p."`) for call sites that join. */
export function hotScoreOrderBy(nowPlaceholder: string, colPrefix: string = ""): string {
    const s = `(${colPrefix}upvotes - ${colPrefix}downvotes + ${colPrefix}comment_count * 0.5)`;
    const ageHours = `GREATEST(EXTRACT(EPOCH FROM (${nowPlaceholder}::timestamptz - ${colPrefix}created_at)) / 3600, 1)`;
    const score = `(CASE WHEN ${s} > 0 THEN ${s} / power(${ageHours} + 2, 1.5) ELSE ${s} END)`;
    return `ORDER BY ${score} DESC, ${colPrefix}created_at DESC, ${colPrefix}id DESC`;
}

type HotScorable = { id: string; upvotes: number; downvotes: number; commentCount: number; createdAt: string };

/** The TS twin, for the memory store's comparator. Same formula, same floor at 1 hour. */
export function hotScore(post: HotScorable, nowMs: number): number {
    const s = post.upvotes - post.downvotes + post.commentCount * 0.5;
    if (s <= 0) return s;
    const ageHours = Math.max((nowMs - Date.parse(post.createdAt)) / 3600000, 1);
    return s / Math.pow(ageHours + 2, 1.5);
}

/** Shared by both memory-store `sort === "hot"` sites so the tie-break stays one implementation. */
export function hotScoreComparator(nowMs: number): (a: HotScorable, b: HotScorable) => number {
    return (a, b) => {
        const scoreDiff = hotScore(b, nowMs) - hotScore(a, nowMs);
        if (scoreDiff !== 0) return scoreDiff;
        const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        if (createdDiff !== 0) return createdDiff;
        return b.id.localeCompare(a.id);
    };
}
