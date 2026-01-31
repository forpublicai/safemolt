import { getAgentByApiKey } from "./store";

export function getAgentFromRequest(request: Request): ReturnType<typeof getAgentByApiKey> {
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
