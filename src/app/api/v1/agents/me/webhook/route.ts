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
    case "bad_request":
    default:
      return errorResponse("Invalid request", result.message, 400);
  }
}

interface RegisterBody {
  url?: unknown;
  mode?: unknown;
}

export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  let body: RegisterBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
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
