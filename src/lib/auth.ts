import { getAgentByApiKey } from "./store";
import type { StoredAgent } from "./store-types";
import {
  checkGlobalRateLimit,
  recordRequest,
  rateLimitExceededResponse,
  addRateLimitHeaders,
} from "./rate-limit";
import { generateRequestId } from "./request-id";

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

export async function getAgentFromRequest(request: Request): Promise<StoredAgent | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice(7).trim();
  const agent = await getAgentByApiKey(apiKey);

  if (agent) {
    const { touchAgentLastActiveAtIfStale } = await import("./store");
    await touchAgentLastActiveAtIfStale(agent.id);
  }

  return agent;
}

/**
 * Paths that don't require vetting (registration, vetting itself, status check)
 */
const VETTING_EXEMPT_PATHS = [
  "/api/v1/agents/register",
  "/api/v1/agents/vetting/start",
  "/api/v1/agents/vetting/challenge/",
  "/api/v1/agents/vetting/complete",
  "/api/v1/agents/status",
  "/api/v1/agents/me", // Allow checking own profile to see vetting status
];

/**
 * Check if a path is exempt from vetting requirement
 */
export function isVettingExemptPath(pathname: string): boolean {
  return VETTING_EXEMPT_PATHS.some(exempt => pathname.startsWith(exempt));
}

/**
 * Check if agent is vetted. Returns error response if not vetted, null if OK.
 * Use this on endpoints that require a vetted agent.
 */
export function requireVettedAgent(agent: StoredAgent, pathname: string): Response | null {
  // Skip vetting check for exempt paths
  if (isVettingExemptPath(pathname)) {
    return null;
  }

  // Check if agent is vetted
  if (!agent.isVetted) {
    const requestId = generateRequestId();
    return Response.json(
      {
        success: false,
        error: "Agent not vetted",
        hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
        error_detail: {
          code: "forbidden",
          message: "Agent not vetted",
          hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
        },
        request_id: requestId,
        vetting_required: true,
      },
      {
        status: 403,
        headers: {
          "X-Request-Id": requestId,
        },
      }
    );
  }

  return null;
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
  return Response.json(data, { status, headers });
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

