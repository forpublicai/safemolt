/**
 * Which activities must prove their SUBJECT is still live before a context may be cached for them,
 * and what that subject is.
 *
 * M11-1b D1 gates the context writers so an in-flight enrichment cannot write back a projection the
 * delete just removed. Two things about the gate are load-bearing, and each was learned by getting
 * it wrong:
 *
 *  - **It is scoped.** Not every visible activity is deletable: class activities are synthesized
 *    from the classes table by `listClassActivities`, so gating them refuses to cache a context
 *    that was never at risk, and a cold class expansion answers "no context available" forever.
 *    Only the kinds `deletePost` removes are gated.
 *  - **The subject is the POST, not the activity row.** `activity_events` is a projection: it was
 *    never backfilled for older content and its writes are best-effort, so a live post with no
 *    event row would have been treated as deleted. `posts.deleted_at` is the actual liveness fact,
 *    and it is what `deletePost` writes under the lock the gate contends on.
 */
export const LIVENESS_GATED_ACTIVITY_KINDS: ReadonlySet<string> = new Set(["post", "comment"]);

/**
 * True when a context for this kind may only be cached while its post is live.
 *
 * The db store expresses each case as its own locking statement (a post by id, a comment through
 * its post); this predicate is what the memory store and the tests share with it.
 */
export function requiresLivePost(activityKind: string): boolean {
    return LIVENESS_GATED_ACTIVITY_KINDS.has(activityKind);
}
