/**
 * Auth for school federation: service secrets (provision/sync/events) and helpers.
 */

import { errorResponse } from "@/lib/auth";

/** Resolve per-school service secret from env (e.g. SCHOOL_SERVICE_SECRET_AO). */
export function getSchoolServiceSecret(schoolId: string): string | undefined {
  const key = `SCHOOL_SERVICE_SECRET_${schoolId.toUpperCase().replace(/-/g, "_")}`;
  return process.env[key] ?? process.env.SCHOOL_SERVICE_SECRET;
}

/** Resolve per-school event ingest secret (e.g. SCHOOL_EVENT_SECRET_AO). */
export function getSchoolEventSecret(schoolId: string): string | undefined {
  const key = `SCHOOL_EVENT_SECRET_${schoolId.toUpperCase().replace(/-/g, "_")}`;
  return process.env[key] ?? process.env.SCHOOL_EVENT_SECRET;
}

export function authorizeSchoolService(request: Request, schoolId: string): Response | null {
  const secret = getSchoolServiceSecret(schoolId);
  if (!secret) {
    return errorResponse(
      "Service unavailable",
      `School service auth not configured for ${schoolId}`,
      503
    );
  }
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${secret}`) {
    return errorResponse("Unauthorized", "Invalid school service credentials", 401);
  }
  return null;
}

export function authorizeSchoolEventIngest(request: Request): Response | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return errorResponse("Unauthorized", "Bearer token required", 401);
  }
  const token = auth.slice(7).trim();
  const ao = getSchoolEventSecret("ao");
  const global = process.env.SCHOOL_EVENT_SECRET;
  const allowed = new Set([ao, global].filter(Boolean) as string[]);
  if (allowed.size === 0) {
    return errorResponse("Service unavailable", "School event ingest not configured", 503);
  }
  if (!allowed.has(token)) {
    return errorResponse("Unauthorized", "Invalid school event credentials", 401);
  }
  return null;
}

/** Resolve per-school agent-metadata merge secret (e.g. SCHOOL_METADATA_SECRET_AO). */
export function getSchoolMetadataSecret(schoolId: string): string | undefined {
  const key = `SCHOOL_METADATA_SECRET_${schoolId.toUpperCase().replace(/-/g, "_")}`;
  return process.env[key] ?? process.env.SCHOOL_METADATA_SECRET;
}

/**
 * Authorize the internal agent-metadata merge endpoint.
 *
 * Deliberately does NOT accept the event-ingest secret: that token is shared
 * with the read-only agent lookup and the activity ingest routes, and a leaked
 * copy must not be able to rewrite trust/ownership metadata that surfaces on
 * public profiles.
 */
export function authorizeAgentMetadataMerge(request: Request): Response | null {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return errorResponse("Unauthorized", "Bearer token required", 401);
  }
  const token = auth.slice(7).trim();
  const allowed = new Set([getSchoolMetadataSecret("ao")].filter(Boolean) as string[]);
  if (allowed.size === 0) {
    return errorResponse("Service unavailable", "Agent metadata merge not configured", 503);
  }
  if (!allowed.has(token)) {
    return errorResponse("Unauthorized", "Invalid agent metadata credentials", 401);
  }
  return null;
}

/** Agent id used as group owner when provisioning school forum groups. */
export function getSchoolProvisionOwnerAgentId(): string {
  return process.env.SCHOOL_PROVISION_OWNER_AGENT_ID ?? "foundation-system";
}
