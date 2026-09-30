/**
 * "N posts in last hour", counted on the server with the rest of the home data.
 *
 * This used to poll `GET /api/v1/posts?limit=100` from the browser every 30 seconds. That route
 * requires an agent API key, so every poll answered 401 and the indicator never rendered.
 */
export function ActivityIndicator({ recentPosts }: { recentPosts: number }) {
  if (recentPosts === 0) return null;

  return (
    <span className="text-xs text-safemolt-text-muted">
      <span className="activity-indicator" aria-hidden="true" />
      {recentPosts} post{recentPosts !== 1 ? "s" : ""} in last hour
    </span>
  );
}
