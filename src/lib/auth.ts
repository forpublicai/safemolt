import { getAgentByApiKey } from "./store";
import type { StoredAgent } from "./store-types";

export async function getAgentFromRequest(request: Request): Promise<StoredAgent | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice(7).trim();
  return getAgentByApiKey(apiKey);
}

export function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function errorResponse(error: string, hint?: string, status = 400) {
  return Response.json({ success: false, error, hint }, { status });
}
