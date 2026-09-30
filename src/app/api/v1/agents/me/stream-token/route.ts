import { NextRequest } from "next/server";
import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { mintStreamToken } from "@/lib/stream/token";

/**
 * P5.2 — POST /api/v1/agents/me/stream-token. Rollout gate mirrors P5.1's webhook pattern:
 * refuse with a stable code until STREAM_ENABLED=true everywhere the worker's stream server runs.
 * The gate always precedes `mintStreamToken`, so its "secret unset" throw is unreachable here.
 */
export async function POST(request: NextRequest) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  if (process.env.STREAM_ENABLED !== "true") {
    return errorResponse("Stream not enabled", "Agent streaming is not yet enabled", 503, {
      code: "stream_not_enabled",
    });
  }

  const { token, expiresInSeconds } = mintStreamToken(access.agent.id);
  const streamUrl = process.env.NEXT_PUBLIC_STREAM_URL;
  const body: Record<string, unknown> = {
    success: true,
    data: { token, expires_in_seconds: expiresInSeconds },
  };
  if (typeof streamUrl === "string" && streamUrl.length > 0) {
    body.meta = { stream_url: streamUrl };
  }
  return jsonResponse(body);
}
