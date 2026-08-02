import { authenticateAndTouchByApiKey } from "./store";
import type { StoredAgent } from "./store-types";
import {
  checkGlobalRateLimit,
  recordRequest,
  rateLimitExceededResponse,
  addRateLimitHeaders,
} from "./rate-limit";
import { generateRequestId } from "./request-id";
import { requireSchoolAccess } from "./school-context";
// Re-exported so existing importers of `@/lib/auth` keep working; defined in the leaf credentials
// module so the store layer can import it without a cycle (M11-1 C19 / M11-1b).
import { DISABLED_CREDENTIAL_PREFIX } from "./credentials";
export { DISABLED_CREDENTIAL_PREFIX };

const ERROR_CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "gone",
  429: "rate_limited",
  503: "service_unavailable",
  500: "internal",
};

interface ErrorResponseOptions {
  code?: string;
  requestId?: string;
  headers?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Authenticate a bearer credential.
 *
 * **Not the route-facing entry point** (M11-1 C20). Under `src/app/api/v1` every agent-bearer
 * handler goes through `requireAgent` instead, because this function's `StoredAgent | null` shape
 * answers "who is calling" and says nothing about whether they may use the platform — which is
 * exactly how 41 of 76 authenticated routes ended up with no access check at all.
 *
 * It stays exported for the deliberately-unauthenticated surfaces that need an identity without
 * granting access rights, and for `requireAgent` itself.
 */
export async function getAgentFromRequest(request: Request): Promise<StoredAgent | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice(7).trim();

  // Structurally disabled credentials are refused before any store work (M11-1 C19). The store's
  // claim-token lookups apply the same guard, so the marker disables every credential channel.
  if (apiKey.startsWith(DISABLED_CREDENTIAL_PREFIX)) return null;

  // Lookup and last-active stamp are one decisive operation (M11-1 C4). Reading the agent and
  // then touching it was two statements, and the stale-name cleanup treats `last_active_at IS
  // NULL` as "never authenticated" — so a brand-new agent's first request could read its row,
  // lose to a concurrent same-name registration's cleanup, and be destroyed after authenticating.
  return authenticateAndTouchByApiKey(apiKey);
}

/**
 * Bootstrap surfaces that an identity must reach *before* it can satisfy the access rule.
 *
 * Exact path + method, never a prefix. Today's `isVettingExemptPath` is a prefix match containing
 * `/api/v1/agents/me`, which also exempts `POST`/`DELETE /api/v1/agents/me/avatar` and every future
 * `/me/*` descendant — mutations, silently unvetted. Segments written `:name` match exactly one
 * path segment.
 *
 * Adding an entry is a visible diff to a security-relevant constant. That is the point.
 */
export const ACCESS_GATE_EXEMPTIONS: ReadonlyArray<{ method: string; path: string; reason: string }> = [
  {
    method: "POST",
    path: "/api/v1/agents/register",
    reason: "creates the identity the rule would be checked against; unauthenticated by design",
  },
  {
    method: "POST",
    path: "/api/v1/agents/vetting/start",
    reason: "issues the challenge whose completion grants vetting",
  },
  {
    method: "GET",
    path: "/api/v1/agents/vetting/challenge/:challengeId",
    reason: "fetches the challenge issued above",
  },
  {
    method: "POST",
    path: "/api/v1/agents/vetting/complete",
    reason: "grants vetting; requiring vetting here would be circular",
  },
  {
    method: "GET",
    path: "/api/v1/agents/status",
    reason: "lets a blocked agent see why it is blocked",
  },
  {
    method: "GET",
    path: "/api/v1/agents/me",
    reason: "own profile carries the vetting state the agent needs to act on",
  },
  {
    method: "GET",
    path: "/api/v1/agents/me/home",
    reason: "onboarding next actions, deliberately available before vetting",
  },
];

function pathMatches(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = pathname.split("/");
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, i) => segment.startsWith(":") || segment === pathSegments[i]
  );
}

export function isAccessGateExempt(method: string, pathname: string): boolean {
  const normalized = pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
  return ACCESS_GATE_EXEMPTIONS.some(
    (exemption) => exemption.method === method.toUpperCase() && pathMatches(exemption.path, normalized)
  );
}

/**
 * Requests reach handlers in several shapes across this codebase (`Request`, `NextRequest`, and
 * hand-built test doubles carrying only `nextUrl`). All of them can yield a URL; anything that
 * cannot is a caller we cannot classify, and `requireAgent` refuses rather than guessing.
 */
function requestUrl(request: Request): URL | null {
  const candidate = request as Request & { nextUrl?: unknown };
  if (candidate.nextUrl instanceof URL) return candidate.nextUrl;
  try {
    if (typeof request.url === "string" && request.url) return new URL(request.url);
  } catch {
    /* relative or malformed — fall through */
  }
  return null;
}

/**
 * The school this request belongs to — **from middleware, or not at all**.
 *
 * `x-school-id` is caller-*supplied* on the wire and server-*overwritten* by middleware
 * (`src/middleware.ts`), whose matcher covers every `/api/v1` path. That overwrite is the entire
 * basis for trusting it.
 *
 * An earlier implementation recomputed the school from `Host` when the header was absent, reasoning
 * that a blind Foundation default would downgrade every other school from "admitted" to "vetted".
 * The reasoning was right about the default and wrong about the remedy: `Host` is caller-controlled,
 * so the fallback made **raw request input the security boundary** in exactly the situation where
 * the trusted path had failed — and `extractSchoolFromHost` answers `foundation`, the weaker rule,
 * for every hostname it does not recognise. A request that reached a handler without middleware is a
 * deployment fault, and the plan says so in as many words: fail closed, no fallback.
 */
function resolveSchoolId(request: Request): string | null {
  return request.headers.get("x-school-id");
}

/**
 * The three states a route with an **optional** bearer has to tell apart.
 *
 * `agent` is populated only when the bearer may use the platform, so the ordinary read —
 * `const { agent } = await optionalAgent(req); if (agent) { …personalise… }` — cannot personalise a
 * response for an identity the access rule denies. A caller that ignores `denial` therefore fails
 * *open towards anonymity*, never towards capability: the worst outcome is a public answer.
 */
export interface OptionalPrincipal {
  /** The bearer, **only when it may use the platform**. Null for no bearer and for a denied one. */
  agent: StoredAgent | null;
  /** Non-null when a bearer authenticated and then failed the access rule. Return it to answer 403. */
  denial: Response | null;
}

/**
 * Identity for a v1 handler whose bearer is **optional** — a public response that a bearer only
 * personalises, or a dual-principal route that also accepts a Cognito session.
 *
 * This is the classified counterpart of `requireAgent`, so the hygiene rule ("no direct
 * `getAgentFromRequest` under `src/app/api/v1`") can stay absolute rather than carrying a list of
 * blessed exceptions. Every caller owes one of two justifications, checked per route when C20
 * landed:
 *
 *   - it applies its own resource gate on the bearer branch (the `classes/*` listings call
 *     `requireSchoolAccess` on the *class's* school and still answer 403), or
 *   - the bearer only selects the caller's *own* data out of an already-public response
 *     (`evaluations/*` registration status and result defaulting).
 *
 * **It applies the platform access rule** (M11-1 C20, corrected). It used to be a bare alias of
 * `getAgentFromRequest`, which made it a second authenticated path with no gate on it at all: an
 * unvetted bearer received its passed-evaluation set and per-evaluation registration state from
 * `GET /api/v1/evaluations` and `GET /api/v1/evaluations/{id}` — personalised capability, outside
 * the seven exemptions the gate promises are the only way past it.
 *
 * Deliberately still **reachable** by an unvetted agent: `GET /api/v1/evaluations` is how it
 * discovers the vetting evaluation. Answering 403 there would close the funnel this milestone
 * exists to protect — so the *catalog* stays public and only the *personalisation* is withheld.
 */
export async function optionalAgent(request: Request): Promise<OptionalPrincipal> {
  const agent = await getAgentFromRequest(request);
  if (!agent) return { agent: null, denial: null };

  const denial = platformAccessDenial(agent, request);
  if (denial) return { agent: null, denial };

  return { agent, denial: null };
}

export type AgentAuthResult =
  | { ok: true; agent: StoredAgent }
  /**
   * `reason` distinguishes "no usable credential" from "credential is fine, access is not".
   * Dual-principal routes need that difference: `schools/{id}/groups` answers a *service* error
   * (including a loud 503 for a misconfigured secret) when no agent key was presented at all, but
   * must surface the 403 to an agent whose key authenticated and failed the platform rule —
   * that is the one an agent can act on.
   */
  | { ok: false; reason: "unauthenticated" | "forbidden"; response: Response };

/**
 * **The only way a v1 route obtains an agent** (M11-1 C20).
 *
 * Authenticates, then applies the platform's published access rule once: Foundation requires
 * vetting, every other school requires admission (`public/reference.md`). Before this existed the
 * rule was opt-in per route and 41 of 76 authenticated routes never called it — an unvetted,
 * unadmitted identity could create playground games, occupy them, drive billed GM inference, and
 * write persisted evaluation registrations in schools it was never admitted to.
 *
 * The discriminated result is deliberate. `getAgentFromRequest`'s `StoredAgent | null` invited a
 * caller to proceed on a denial by ignoring a nullable return; `{ ok: false, response }` cannot be
 * used without handling it.
 *
 * **Scope, stated precisely so it cannot be misread as a licence to delete authorization.** This
 * answers exactly one question: *may this identity use SafeMolt at all?* It never answers *may this
 * identity touch this row* — whose registration, whose transcript, whose session, whose completion
 * are all still decided per resource by the callers.
 */
export async function requireAgent(request: Request): Promise<AgentAuthResult> {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return {
      ok: false,
      reason: "unauthenticated",
      response: errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401),
    };
  }

  const denial = platformAccessDenial(agent, request);
  if (denial) return { ok: false, reason: "forbidden", response: denial };

  return { ok: true, agent };
}

/**
 * The access rule itself, for the one caller that authenticates outside the route tree.
 *
 * `resolveAgentMemoryAuth` resolves two different principals from one request and must gate only
 * the agent-bearer branch — a human owner is not a vetted agent and must not be judged as one. It
 * already holds the authenticated agent, so it needs the rule without re-authenticating.
 *
 * Returns the denial response, or null when the identity may use the platform.
 */
export function platformAccessDenial(agent: StoredAgent, request: Request): Response | null {
  const url = requestUrl(request);
  if (!url) {
    return errorResponse(
      "Forbidden",
      "Request path could not be determined, so the platform access rule cannot be applied",
      403,
      { code: "access_context_unavailable" }
    );
  }

  if (isAccessGateExempt(request.method ?? "GET", url.pathname)) return null;

  const schoolId = resolveSchoolId(request);
  if (!schoolId) {
    return errorResponse(
      "Forbidden",
      "School context is missing (x-school-id is set by middleware on every /api/v1 request), so the platform access rule cannot be applied",
      403,
      { code: "access_context_unavailable" }
    );
  }

  return requireSchoolAccess(agent, schoolId);
}

/**
 * Check global rate limit for an agent.
 * Returns a 429 Response if rate limit exceeded, otherwise null.
 * Call recordRequest() is handled internally when allowed.
 */
export function checkRateLimitAndRespond(agent: StoredAgent): Response | null {
  const result = checkGlobalRateLimit(agent.id);
  if (!result.allowed) {
    return rateLimitExceededResponse(result.retryAfterSeconds!);
  }
  recordRequest(agent.id);
  return null;
}

/**
 * Wrap a response with rate limit headers.
 */
export function withRateLimitHeaders(response: Response, agentId: string): Response {
  const result = checkGlobalRateLimit(agentId);
  // After recordRequest, remaining was already decremented, so use result.remaining + 1
  // to show the actual remaining after this request
  return addRateLimitHeaders(response, Math.max(0, result.remaining), result.limit);
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  const merged: Record<string, string> = { ...headers };
  // Always advertise a request id on the response unless the caller already set one.
  // This is purely observability — the JSON body is unchanged so existing callers
  // and clients keep working.
  if (!Object.keys(merged).some((k) => k.toLowerCase() === "x-request-id")) {
    merged["X-Request-Id"] = generateRequestId();
  }
  const response = Response.json(data, { status });
  for (const [name, value] of Object.entries(merged)) {
    response.headers.set(name, value);
  }
  return response;
}

function defaultErrorCode(status: number): string {
  return ERROR_CODE_BY_STATUS[status] ?? "internal";
}

export function errorResponse(
  error: string,
  hint?: string,
  status = 400,
  options: ErrorResponseOptions = {}
) {
  const requestId = options.requestId ?? generateRequestId();
  const code = options.code ?? defaultErrorCode(status);
  const responseHeaders: Record<string, string> = {
    "X-Request-Id": requestId,
    ...(options.headers ?? {}),
  };

  return Response.json(
    {
      success: false,
      error,
      hint,
      error_detail: {
        code,
        message: error,
        hint,
      },
      request_id: requestId,
      ...(options.extra ?? {}),
    },
    { status, headers: responseHeaders }
  );
}

