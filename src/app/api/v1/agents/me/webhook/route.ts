import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { registerWebhook, getWebhook, removeWebhook } from "@/lib/actions/webhooks";
import type { ActionResult } from "@/lib/actions/types";

/**
 * M11b Lane W (P5.1) — POST/GET/DELETE /api/v1/agents/me/webhook. A thin adapter: the action owns
 * the rollout gate, URL hygiene, SSRF resolve and the secret-once rule.
 */

function webhookRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "webhooks_not_enabled":
      return errorResponse("Webhooks not enabled", result.message, 503, { code: "webhooks_not_enabled" });
    case "not_found":
      return errorResponse("Not found", result.message, 404);
    case "bad_request":
    default:
      return errorResponse("Invalid request", result.message, 400);
  }
}

interface RegisterBody {
  url?: unknown;
  mode?: unknown;
}

type ParsedBody = { ok: true; body: RegisterBody } | { ok: false; response: Response };

/**
 * F9: a syntactically valid `null`/array/primitive body parses fine but is not an object — property
 * reads on it would otherwise throw and answer 500 instead of 400. Split out to keep `POST` simple.
 */
async function parseRegisterBody(request: NextRequest): Promise<ParsedBody> {
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: errorResponse("Invalid request", "Request body must be a JSON object", 400) };
    }
    return { ok: true, body: parsed as RegisterBody };
  } catch {
    return { ok: false, response: errorResponse("Invalid JSON", undefined, 400) };
  }
}

export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  const parsed = await parseRegisterBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (typeof body.url !== "string" || body.url.length === 0) {
    return errorResponse("Invalid request", "url is required", 400);
  }
  if (body.mode !== undefined && body.mode !== "primary" && body.mode !== "both") {
    return errorResponse("Invalid request", 'mode must be "primary" or "both"', 400);
  }
  const mode = body.mode === "both" ? "both" : "primary";

  const result = await registerWebhook(access.agent, { url: body.url, mode });
  if (!result.ok) return webhookRefusal(result);
  return jsonResponse({ success: true, data: result.data }, 200);
}

export async function GET(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  const result = await getWebhook(access.agent);
  if (!result.ok) return webhookRefusal(result);
  return jsonResponse({ success: true, data: result.data }, 200);
}

export async function DELETE(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  const result = await removeWebhook(access.agent);
  if (!result.ok) return webhookRefusal(result);
  return jsonResponse({ success: true, data: result.data }, 200);
}
