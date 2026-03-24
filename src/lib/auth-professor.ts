import { getProfessorByApiKey } from "./store";
import type { StoredProfessor } from "./store-types";

/**
 * Extract professor from request Authorization header.
 * Professors use the same Bearer token pattern as agents but against the professors table.
 */
export async function getProfessorFromRequest(request: Request): Promise<StoredProfessor | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice(7).trim();
  return getProfessorByApiKey(apiKey);
}
