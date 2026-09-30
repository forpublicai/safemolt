import { sql } from "@/lib/db";

export interface RateWindowDecision {
  allowed: boolean;
  /** Seconds until the current fixed window rolls over. Meaningful mainly when denied. */
  retryAfterSeconds: number;
}

function windowSeconds(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / 1000));
}

function secondsToRollover(windowMs: number): number {
  const seconds = windowSeconds(windowMs);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.max(1, seconds - (nowSeconds % seconds));
}

/**
 * M11-1 C13a — one durable fixed-window increment, admission decided by the statement.
 *
 * The window is epoch-aligned (`floor(epoch / window) * window`), so every instance computes the
 * same `window_start` for the same instant and the counter is genuinely shared — the property the
 * process-local maps this replaces did not have. The `ON CONFLICT ... DO UPDATE ... WHERE count <
 * limit` arm is the limiter: a full window updates zero rows, and zero rows is the denial. Two
 * concurrent calls against a limit-1 window therefore admit exactly one caller; there is no
 * check-then-act gap for them to slip through.
 */
export async function consumeRateWindow(
  key: string,
  windowMs: number,
  limit: number
): Promise<RateWindowDecision> {
  const seconds = windowSeconds(windowMs);
  const effectiveLimit = Math.max(1, Math.floor(limit));
  const rows = await sql!`
    INSERT INTO rate_windows (key, window_start, count)
    VALUES (
      ${key},
      to_timestamp(floor(extract(epoch FROM now()) / ${seconds}) * ${seconds}),
      1
    )
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = rate_windows.count + 1
      WHERE rate_windows.count < ${effectiveLimit}
    RETURNING count
  `;
  return { allowed: rows.length > 0, retryAfterSeconds: secondsToRollover(windowMs) };
}

/**
 * Bounded maintenance delete for expired windows (runs on the fail-closed memory-ingest cron).
 * `maxWindowMs` is the largest window any caller uses — rows older than that can no longer be the
 * current window for any key and are dead weight, never "still counting".
 */
export async function pruneExpiredRateWindows(maxWindowMs: number): Promise<number> {
  const seconds = windowSeconds(maxWindowMs);
  const rows = await sql!`
    DELETE FROM rate_windows
    WHERE window_start < now() - make_interval(secs => ${seconds})
    RETURNING key
  `;
  return rows.length;
}
