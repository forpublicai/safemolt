/**
 * M11-1 C13a — window configuration and the address-keyed enforcement helper for the three
 * unauthenticated, cost-bearing endpoints (activity context, newsletter subscribe, agent
 * register). One definition so the prune cutoff can be *derived* from the set of windows in use
 * rather than guessed, and so the "unknown"-bucket tightening is one rule instead of three.
 *
 * The authenticated API's general limiter (`src/lib/rate-limit.ts`) deliberately stays
 * process-local — that is M10 B1/D4's transport-limiter scope, not this module's.
 */
import { getTrustedClientAddress, UNKNOWN_CLIENT_ADDRESS } from "@/lib/client-address";
import { consumeRateWindow } from "@/lib/store";
import { newsletterResendWindowMs } from "@/lib/store/rate-limit-windows";

export { newsletterResendWindowMs };

export interface PublicRateWindowConfig {
  /** Key prefix; the trusted client address (or a normalized email) completes the key. */
  scope: string;
  windowMs: number;
  limit: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function activityContextWindow(): PublicRateWindowConfig {
  return {
    scope: "activity-context",
    windowMs: MINUTE_MS,
    limit: positiveIntEnv("ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE", 120),
  };
}

export function newsletterIpWindow(): PublicRateWindowConfig {
  return {
    scope: "newsletter-ip",
    windowMs: MINUTE_MS,
    limit: positiveIntEnv("NEWSLETTER_SUBSCRIBE_IP_LIMIT_PER_MINUTE", 5),
  };
}

export function newsletterEmailWindow(): PublicRateWindowConfig {
  return { scope: "newsletter-email", windowMs: newsletterResendWindowMs(), limit: 1 };
}

export function registerIpWindow(): PublicRateWindowConfig {
  return {
    scope: "register-ip",
    windowMs: HOUR_MS,
    limit: positiveIntEnv("AGENT_REGISTER_IP_LIMIT_PER_HOUR", 30),
  };
}

export function registerEmailWindow(): PublicRateWindowConfig {
  return {
    scope: "register-email",
    windowMs: HOUR_MS,
    limit: positiveIntEnv("AGENT_REGISTER_EMAIL_LIMIT_PER_HOUR", 3),
  };
}

/**
 * Prune cutoff for the maintenance cron: the largest window any caller uses. Derived, not
 * hardcoded, so adding a longer window automatically extends retention instead of silently
 * truncating a live counter.
 */
export function maxPublicRateWindowMs(): number {
  return Math.max(
    activityContextWindow().windowMs,
    newsletterIpWindow().windowMs,
    newsletterEmailWindow().windowMs,
    registerIpWindow().windowMs,
    registerEmailWindow().windowMs
  );
}

export interface PublicRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** The limit actually applied (tightened for the unknown bucket). */
  limit: number;
}

/**
 * Address-keyed enforcement. The `"unknown"` bucket is shared by every caller whose address could
 * not be resolved and is limited *more* tightly (a tenth of the allowance, floor 1) — stripping
 * headers must never buy a fresh allowance.
 */
export async function consumeAddressWindow(
  request: Request,
  config: PublicRateWindowConfig
): Promise<PublicRateDecision> {
  const address = getTrustedClientAddress(request);
  const limit =
    address === UNKNOWN_CLIENT_ADDRESS ? Math.max(1, Math.floor(config.limit / 10)) : config.limit;
  const decision = await consumeRateWindow(`${config.scope}:${address}`, config.windowMs, limit);
  return { ...decision, limit };
}

/** Email-keyed enforcement (registration owner_email, newsletter suppression). */
export async function consumeEmailWindow(
  normalizedEmail: string,
  config: PublicRateWindowConfig
): Promise<PublicRateDecision> {
  const decision = await consumeRateWindow(
    `${config.scope}:${normalizedEmail}`,
    config.windowMs,
    config.limit
  );
  return { ...decision, limit: config.limit };
}
