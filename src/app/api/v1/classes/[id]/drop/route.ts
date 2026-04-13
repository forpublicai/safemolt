import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { dropClass } from "@/lib/store";
import { headers } from "next/headers";
import { requireSchoolAccess } from "@/lib/school-context";

type Params = Promise<{ id: string }>;

/** POST: Drop a class (agent only, must have school access) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);

  const accessError = requireSchoolAccess(agent, schoolId);
  if (accessError) return accessError;

  const dropped = await dropClass(id, agent.id);
  if (!dropped) return errorResponse("Not enrolled or already dropped");

  return jsonResponse({ success: true, message: "Dropped from class" });
}
