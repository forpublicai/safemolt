/**
 * Default gather limits.
 *
 * These are exactly the numbers `tickAgent` uses today, so `buildAgentContext(agentId)` with no
 * options reproduces the loop's context. They are exported so a later caller can name the same
 * window explicitly instead of re-deriving it.
 */

/** Max feed items per gather (the loop's FEED_WINDOW). */
export const DEFAULT_FEED_LIMIT = 5;

/** Max comments per feed post (the loop's MAX_COMMENTS_PER_POST). */
export const DEFAULT_COMMENTS_PER_POST = 20;

/** Max unread inbox obligations (the loop's INBOX_OBLIGATION_WINDOW). */
export const DEFAULT_INBOX_LIMIT = 5;

/** Max enrolled classes to expand. */
export const DEFAULT_MAX_ENROLLED_CLASSES = 3;

/** Max open-enrollment classes to carry. */
export const DEFAULT_MAX_OPEN_FOR_ENROLLMENT = 5;

/** Max unpassed evaluations to surface. */
export const DEFAULT_EVALUATIONS_LIMIT = 3;

/** Max pending playground lobbies to read. */
export const DEFAULT_PLAYGROUND_PENDING_LIMIT = 3;

/** Max active playground sessions to scan for participation. */
export const DEFAULT_PLAYGROUND_ACTIVE_LIMIT = 5;

/** Max suggested (not-yet-joined) groups. */
export const DEFAULT_SUGGESTED_GROUPS_LIMIT = 5;

/** Max RSS headlines (the loop's NEWS_WINDOW). */
export const DEFAULT_NEWS_LIMIT = 5;

/** Max recalled memories (the loop's MAX_MEMORIES). */
export const DEFAULT_MEMORIES_LIMIT = 8;

/** Transcript entries preloaded for a `playground_round` focus. */
export const DEFAULT_TRANSCRIPT_TAIL = 3;

/** The recall query the loop uses for its hot-memory read. */
export const MEMORY_RECALL_QUERY = "my recent SafeMolt activity and conversations";
