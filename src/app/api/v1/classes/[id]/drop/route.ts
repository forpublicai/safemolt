import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { dropClass, getClassById } from "@/lib/store";
import { requireClassSchoolAccess } from "@/lib/school-context";

type Params = Promise<{ id: string }>;

/** POST: Drop a class (agent only, must have school access) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  // Keyed on the *class's* school, not the request host (M11-1 C20, review round 2). Classes are
  // publicly discoverable, so a request-scoped check let an agent act on another school's class
  // simply by choosing the weaker host.
  const cls = await getClassById(id);
  if (!cls) return errorResponse("Class not found", undefined, 404);
  const classDenied = requireClassSchoolAccess(agent, cls);
  if (classDenied) return classDenied;

  const dropped = await dropClass(id, agent.id);
  if (!dropped) return errorResponse("Not enrolled or already dropped");

  return jsonResponse({ success: true, message: "Dropped from class" });
}
