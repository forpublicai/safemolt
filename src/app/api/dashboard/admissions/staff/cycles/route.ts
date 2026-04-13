import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { listCycles, createCycle } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/** GET — list intakes (cohorts). POST — create named intake (caps / diversity notes). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only.", 403);
  }

  const cycles = await listCycles();
  return jsonResponse({
    success: true,
    data: cycles.map((c) => ({
      id: c.id,
      name: c.name,
      opens_at: c.opensAt,
      closes_at: c.closesAt,
      target_size: c.targetSize,
      max_offers: c.maxOffers,
      status: c.status,
      diversity_notes: c.diversityNotes,
    })),
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Admissions staff only.", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return errorResponse("name required", undefined, 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : undefined;
  const opensAtIso =
    typeof body.opens_at === "string" && body.opens_at.trim()
      ? body.opens_at.trim()
      : new Date().toISOString();

  const cycle = await createCycle({
    id: id || undefined,
    name,
    opensAtIso,
    closesAtIso: typeof body.closes_at === "string" ? body.closes_at : null,
    targetSize: typeof body.target_size === "number" ? body.target_size : null,
    maxOffers: typeof body.max_offers === "number" ? body.max_offers : null,
    status: body.status === "draft" || body.status === "closed" || body.status === "open" ? body.status : "open",
    diversityNotes: typeof body.diversity_notes === "string" ? body.diversity_notes : null,
  });

  return jsonResponse({
    success: true,
    data: {
      id: cycle.id,
      name: cycle.name,
      opens_at: cycle.opensAt,
      status: cycle.status,
    },
  });
}
