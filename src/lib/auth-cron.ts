import { timingSafeEqual } from "crypto";

import { errorResponse } from "./auth";

/**
 * Authorization for the scheduled-job routes listed in `vercel.json`'s `crons` array (M11-1 C13).
 *
 * Every one of those four targets spends billed inference — agent loop ticks, GM round
 * progression, memory reconciliation embeddings, session creation — and each carried its own copy
 * of `if (!cronSecret) return true`. An unset variable therefore did not mean "unconfigured", it
 * meant **"authorize everyone"**, so any anonymous caller could drive paid work in a loop.
 *
 * Scope is those four targets and nothing else. `internal/agent-metadata` and `internal/agents/[id]`
 * keep their own credentials deliberately: the federation auth module prohibits the broader event
 * token for metadata writes, and letting one cron secret authorize them would widen it right back.
 */

/** Opt-in for running the scheduled routes locally with no secret configured. Never set this in a deployment. */
const DEV_BYPASS_FLAG = "ALLOW_INSECURE_CRON";

function unauthorized(hint: string): Response {
  return errorResponse("Unauthorized", hint, 401);
}

function presentedBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Compare without leaking the secret through response timing.
 *
 * `timingSafeEqual` throws on a length mismatch, so lengths are compared first — which does leak
 * the secret's *length*, the one property an attacker gains nothing from.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Returns a 401 response when the caller may not run a scheduled job, or null when it may.
 *
 * **The configured bearer secret is the only accepted credential.** `x-vercel-cron: 1` used to be
 * honoured alongside it and is now refused: it is a caller-shaped header, not an authentication
 * guarantee, so on a direct or non-Vercel deployment it was a one-header bypass of the whole check.
 * Vercel's managed crons send `Authorization: Bearer $CRON_SECRET`, so the bearer check covers the
 * deployed configuration on its own — provided the variable is actually set there, which is a
 * deploy step this code cannot verify and the plan sequences ahead of shipping it.
 */
export function requireCronAuth(request: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim();

  if (secret) {
    const presented = presentedBearer(request);
    if (presented && secretMatches(presented, secret)) return null;
    return unauthorized("Scheduled jobs require Authorization: Bearer <CRON_SECRET>");
  }

  // No secret configured. Local development opts in explicitly; absent configuration never does.
  // The flag is additionally inert in production, so setting it there — by accident, or by anyone
  // who can reach the build environment — cannot reopen what this function exists to close.
  if (process.env.NODE_ENV !== "production" && process.env[DEV_BYPASS_FLAG] === "true") return null;

  return unauthorized(
    `CRON_SECRET is not configured, so scheduled jobs are refused. Set it, or set ${DEV_BYPASS_FLAG}=true for local development.`
  );
}
