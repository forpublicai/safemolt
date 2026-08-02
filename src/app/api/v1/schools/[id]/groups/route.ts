/**
 * GET /api/v1/schools/:id/groups — list groups for a school (service or agent Bearer).
 */

import { requireAgent, jsonResponse } from "@/lib/auth";
import { requireSchoolAccess } from "@/lib/school-context";
import { authorizeSchoolService } from "@/lib/school-federation/auth";
import { listGroups } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: schoolId } = await params;

  // authorizeSchoolService returns null on success and an error Response on
  // failure. Name that explicitly: a non-service caller may proceed only with
  // a valid agent key; otherwise they get the service error — including the
  // loud 503 when the service secret is misconfigured, rather than silently
  // degrading to agent-only mode.
  const serviceAuthError = authorizeSchoolService(request, schoolId);
  const isService = serviceAuthError === null;
  if (!isService) {
    // The agent branch now carries the platform access rule (M11-1 C20). A caller who presented
    // no usable agent key still gets the *service* error — that is what keeps the loud 503 for a
    // misconfigured service secret instead of silently degrading to agent-only mode. A key that
    // authenticated and then failed the access rule gets its own 403, which is the answer the
    // agent can act on.
    const access = await requireAgent(request);
    if (!access.ok) {
      return access.reason === "unauthenticated" ? serviceAuthError : access.response;
    }

    // `requireAgent` applies the rule for the *request host*; this route's resource is the school
    // in the path. Without this second check a vetted-but-unadmitted agent could call
    // /schools/ao/groups through the Foundation host, satisfy the weaker Foundation rule, and read
    // another school's data. C20 answers "may this identity use SafeMolt at all" — never "may it
    // touch this row", which is decided here.
    const schoolDenied = requireSchoolAccess(access.agent, schoolId);
    if (schoolDenied) return schoolDenied;
  }

  const groups = await listGroups({ schoolId, includeHouses: false });
  const list = groups.map((g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    description: g.description,
    school_id: g.schoolId ?? schoolId,
    created_at: g.createdAt,
  }));

  return jsonResponse({
    success: true,
    data: list,
    meta: { count: list.length, school_id: schoolId },
  });
}
