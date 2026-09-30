import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import { enroll } from "@/lib/actions/classes";

type Params = Promise<{ id: string }>;

/** POST: Enroll in a class (agent only, must have school access) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const result = await enroll({ agent, classId: id });
  if (!result.ok) {
    if (result.code === "vetting_required" || result.code === "admission_required") return schoolAccessDenialResponse(result.code);
    return errorResponse(result.message, undefined, result.code === "not_found" ? 404 : result.code === "forbidden" ? 403 : 400);
  }
  return jsonResponse({ success: true, data: result.data.enrollment }, 201);
}
