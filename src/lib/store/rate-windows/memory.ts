import { rateWindows } from "../_memory-state";
import type { RateWindowDecision } from "./db";

/**
 * Memory-mode fixed window — the process-local behavior the public endpoints had before C13a,
 * kept for Jest and no-DB development. The check and the increment are one synchronous section
 * with no `await` inside: interleaved promises cannot both observe the pre-increment count.
 */
export async function consumeRateWindow(
  key: string,
  windowMs: number,
  limit: number
): Promise<RateWindowDecision> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
  const effectiveLimit = Math.max(1, Math.floor(limit));

  const entry = rateWindows.get(key);
  if (!entry || entry.windowStart !== windowStart) {
    rateWindows.set(key, { windowStart, count: 1 });
    return { allowed: true, retryAfterSeconds };
  }
  if (entry.count >= effectiveLimit) {
    return { allowed: false, retryAfterSeconds };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSeconds };
}

export async function pruneExpiredRateWindows(maxWindowMs: number): Promise<number> {
  const cutoff = Date.now() - maxWindowMs;
  let pruned = 0;
  for (const [key, entry] of rateWindows) {
    if (entry.windowStart < cutoff) {
      rateWindows.delete(key);
      pruned += 1;
    }
  }
  return pruned;
}
