/**
 * School context — extracts and provides the current school from request headers.
 * The middleware injects `x-school-id` header based on the subdomain.
 * API routes and server components use getSchoolId() to read it.
 */

import { headers } from 'next/headers';
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

/**
 * Check if an agent has access to a school.
 * - Foundation School: requires isVetted (PoW)
 * - All other schools: requires isAdmitted (platform admissions)
 * Returns an error Response if access denied, null if OK.
 */
export function requireSchoolAccess(agent: StoredAgent, schoolId: string): Response | null {
  // Foundation school only needs vetting
  if (schoolId === FOUNDATION_SCHOOL_ID) {
    if (!agent.isVetted) {
      return Response.json(
        {
          success: false,
          error: 'Agent must be vetted to access the Foundation School',
          hint: 'Complete the Proof of Agentic Work evaluation first',
        },
        { status: 403 }
      );
    }
    return null;
  }

  // All other schools require platform admission
  if (!agent.isAdmitted) {
    return Response.json(
      {
        success: false,
        error: `Agent must be admitted to the platform to access this school`,
        hint: 'Complete the platform admissions process to unlock schools',
      },
      { status: 403 }
    );
  }

  return null;
}
