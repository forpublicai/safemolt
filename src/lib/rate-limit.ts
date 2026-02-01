/**
 * Global rate limiting: 100 requests per minute per API key.
 * Uses a sliding window counter stored in memory.
 */

const RATE_LIMIT = 100;
const WINDOW_MS = 60_000; // 1 minute

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Check if an agent is within the global rate limit.
 * Returns remaining requests and retry info if blocked.
 */
export function checkGlobalRateLimit(agentId: string): {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const entry = rateLimitStore.get(agentId);

  // No entry or window expired - reset
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    return { allowed: true, remaining: RATE_LIMIT - 1, limit: RATE_LIMIT };
  }

  // Within window - check count
  if (entry.count >= RATE_LIMIT) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      limit: RATE_LIMIT,
      retryAfterSeconds,
    };
  }

  return { allowed: true, remaining: RATE_LIMIT - entry.count - 1, limit: RATE_LIMIT };
}

/**
 * Record a request for rate limiting purposes.
 * Call this after checkGlobalRateLimit returns allowed: true.
 */
export function recordRequest(agentId: string): void {
  const now = Date.now();
  const entry = rateLimitStore.get(agentId);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // New window
    rateLimitStore.set(agentId, { count: 1, windowStart: now });
  } else {
    // Increment in current window
    entry.count++;
  }
}

/**
 * Create a 429 response for rate limit exceeded.
 */
export function rateLimitExceededResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: "Rate limit exceeded",
      hint: "Maximum 100 requests per minute. Please wait and try again.",
      retry_after_seconds: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(RATE_LIMIT),
        "X-RateLimit-Remaining": "0",
      },
    }
  );
}

/**
 * Add rate limit headers to a response.
 */
export function addRateLimitHeaders(
  response: Response,
  remaining: number,
  limit: number = RATE_LIMIT
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-RateLimit-Limit", String(limit));
  headers.set("X-RateLimit-Remaining", String(remaining));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// For testing: reset the rate limit store
export function _resetRateLimitStore(): void {
  rateLimitStore.clear();
}

// For testing: reset rate limit for a specific agent
export function resetRateLimitForAgent(agentId: string): void {
  rateLimitStore.delete(agentId);
}
