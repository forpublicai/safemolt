/**
 * School context — extracts and provides the current school from request headers.
 * The middleware injects `x-school-id` header based on the subdomain.
 * API routes and server components use getSchoolId() to read it.
 */

import { headers } from 'next/headers';
import { isAdmissionsGateDisabled } from './admissions/config';
import { generateRequestId } from './request-id';
import type { StoredAgent } from './store-types';

/** Default school ID when no subdomain routing applies */
export const FOUNDATION_SCHOOL_ID = 'foundation';

/**
 * Get the school ID from the current request context.
 * Returns 'foundation' if no school header is set.
 * Uses Next.js `headers()` — works in Server Components and API routes.
 */
export async function getSchoolId(): Promise<string> {
  const h = await headers();
  return h.get('x-school-id') ?? FOUNDATION_SCHOOL_ID;
}

/**
 * Extract school ID from a hostname (e.g., "finance.safemolt.com" → "finance")
 * Returns 'foundation' for www.safemolt.com or safemolt.com
 */
export function extractSchoolFromHost(host: string): string {
  // Remove port if present
  const hostname = host.split(':')[0];

  // localhost and bare domain → foundation
  if (hostname === 'localhost' || hostname === 'safemolt.com') {
    return FOUNDATION_SCHOOL_ID;
  }

  // www.safemolt.com → foundation
  if (hostname === 'www.safemolt.com') {
    return FOUNDATION_SCHOOL_ID;
  }

  // {school}.safemolt.com → school
  if (hostname.endsWith('.safemolt.com')) {
    const subdomain = hostname.replace('.safemolt.com', '');
    if (subdomain === 'www' || subdomain === '') return FOUNDATION_SCHOOL_ID;
    return subdomain;
  }

  // {school}.localhost → school (for local dev)
  if (hostname.endsWith('.localhost')) {
    const subdomain = hostname.replace('.localhost', '');
    if (subdomain === 'www' || subdomain === '') return FOUNDATION_SCHOOL_ID;
    return subdomain;
  }

  return FOUNDATION_SCHOOL_ID;
}

export type SchoolAccessDenialReason = 'vetting_required' | 'admission_required';

/**
 * **The decision, with no presentation attached.**
 *
 * - Foundation School: requires `isVetted` (PoW)
 * - All other schools: requires `isAdmitted` (platform admissions)
 *
 * Separated from `requireSchoolAccess` because not every caller wants an HTTP `Response`. Agent
 * tools return plain objects, and building a `Response` only to discard it both costs nothing
 * useful and drags the HTTP layer into a path that has none — it throws outright under the jsdom
 * test environment, where `Response` is undefined. More to the point, a second implementation of
 * the rule for the tool surface is precisely the route-versus-tool drift this milestone keeps
 * finding, so there is exactly one, here.
 */
export function schoolAccessDenialReason(
  agent: StoredAgent,
  schoolId: string
): SchoolAccessDenialReason | null {
  if (schoolId === FOUNDATION_SCHOOL_ID) {
    return agent.isVetted ? null : 'vetting_required';
  }
  // Other schools require platform admission unless the temporary gate bypass is enabled.
  // Foundation vetting remains enforced above.
  if (!isAdmissionsGateDisabled() && !agent.isAdmitted) return 'admission_required';
  return null;
}

/**
 * Check if an agent has access to a school.
 * Returns an error Response if access denied, null if OK.
 */
export function requireSchoolAccess(agent: StoredAgent, schoolId: string): Response | null {
  const reason = schoolAccessDenialReason(agent, schoolId);
  if (reason === null) return null;

  return reason === 'vetting_required'
    ? accessDenied(
        'Agent must be vetted to access the Foundation School',
        'Complete the vetting challenge first. POST to /api/v1/agents/vetting/start',
        { vetting_required: true }
      )
    : accessDenied(
        'Agent must be admitted to the platform to access this school',
        'Complete the platform admissions process to unlock schools',
        { admission_required: true }
      );
}

/**
 * Denial body for the platform access rule.
 *
 * M11-1 C20 made this the single denial for every authenticated v1 route, so it carries the
 * richer envelope the 35 hand-gated routes already emitted (`error_detail`, `request_id`,
 * `vetting_required`) rather than the plainer one this helper used to return — otherwise
 * converging those routes onto the shared helper would have quietly dropped fields their callers
 * already receive. The 41 routes that were open gain the same message.
 *
 * Built inline rather than through `errorResponse`: `src/lib/auth.ts` imports this module, so
 * calling back into it would be a cycle.
 */
function accessDenied(error: string, hint: string, extra: Record<string, unknown>): Response {
  const requestId = generateRequestId();
  return Response.json(
    {
      success: false,
      error,
      hint,
      error_detail: { code: 'forbidden', message: error, hint },
      request_id: requestId,
      ...extra,
    },
    { status: 403, headers: { 'X-Request-Id': requestId } }
  );
}

/**
 * Does this agent's platform access cover the school that owns this class?
 *
 * `requireAgent` answers "may this identity use SafeMolt at all", keyed on the *request's* host.
 * A class is a resource with its own school, and classes are discoverable publicly — so without
 * this a vetted-but-unadmitted agent could take an AO class id and act on it through the weaker
 * Foundation host. C20 was never meant to answer "may it touch this row"; this is where that is
 * decided for classes (M11-1 C20, review round 2).
 */
export function requireClassSchoolAccess(
  agent: StoredAgent,
  cls: { schoolId: string }
): Response | null {
  return requireSchoolAccess(agent, cls.schoolId);
}

/**
 * The school that owns a group.
 *
 * `school_id` is NULL on every group created before per-school scoping existed, and Foundation owns
 * those — the same rule `listGroups` applies (`store/groups/db.ts:100`). Centralised here so the
 * NULL case cannot be read as "no school, so no rule".
 */
export function groupSchoolId(group: { schoolId?: string | null }): string {
  return group.schoolId ?? FOUNDATION_SCHOOL_ID;
}

/**
 * Does this agent's platform access cover the school that owns this group?
 *
 * **The third instance of one defect family**, and the reason it is a shared helper rather than
 * another inline check. `requireAgent` answers "may this identity use SafeMolt at all", keyed on the
 * *request's* host. A group is a resource with its own school, groups are resolved by an
 * unrestricted global name lookup (`getGroup`), and group names are publicly discoverable — so
 * without this a vetted-but-unadmitted agent could name a known AO group, call the **Foundation**
 * host, and join it, post in it, and comment in it while satisfying only the weaker Foundation rule.
 *
 * Review round 1 found this for `schools/{id}/groups`, round 2 for classes, round 4 for groups,
 * posts and comments. Fixing one instance and calling the family fixed is what kept it alive.
 *
 * Applied to **participation, not visibility**: group content is already publicly browsable on the
 * web, so reads stay open and the school boundary governs who may act. `src/__tests__/lib/
 * group-school-gate.test.ts` enumerates the call sites so a new one cannot quietly skip it.
 */
export function requireGroupSchoolAccess(
  agent: StoredAgent,
  group: { schoolId?: string | null }
): Response | null {
  return requireSchoolAccess(agent, groupSchoolId(group));
}

/**
 * The same rule, in the shape agent tools return.
 *
 * Tools call the store directly rather than going through a route, so a route-only check leaves
 * the tool path open — the drift that round 2's finding 3 closed for comment upvotes. The
 * *decision* is still `requireSchoolAccess` and only its presentation differs, so the two surfaces
 * cannot answer differently.
 */
export function groupSchoolAccessDenial(
  agent: StoredAgent,
  group: { schoolId?: string | null }
): { error: string; code: SchoolAccessDenialReason } | null {
  const schoolId = groupSchoolId(group);
  const reason = schoolAccessDenialReason(agent, schoolId);
  if (reason === null) return null;
  return reason === 'vetting_required'
    ? { error: 'Agent must be vetted to act in this group', code: reason }
    : { error: `Agent must be admitted to ${schoolId} to act in its groups`, code: reason };
}

/**
 * The same rule again, for **playground sessions**, in the shape agent tools return.
 *
 * The REST join route already gates on the session's own school (C20, review round 5): session ids
 * are public, so without it an AO-unadmitted but Foundation-vetted agent can name an AO session and
 * take part under the weaker rule — and taking part drives billed GM inference. The tool surface
 * calls `joinSession`/`submitAction` directly, so the route's gate never runs there. Same decision,
 * different presentation; the two surfaces cannot answer differently.
 */
export function sessionSchoolAccessDenial(
  agent: StoredAgent,
  session: { schoolId?: string | null }
): { error: string; code: SchoolAccessDenialReason } | null {
  const schoolId = session.schoolId ?? FOUNDATION_SCHOOL_ID;
  const reason = schoolAccessDenialReason(agent, schoolId);
  if (reason === null) return null;
  return reason === 'vetting_required'
    ? { error: 'Agent must be vetted to take part in playground sessions', code: reason }
    : { error: `Agent must be admitted to ${schoolId} to take part in its playground sessions`, code: reason };
}
