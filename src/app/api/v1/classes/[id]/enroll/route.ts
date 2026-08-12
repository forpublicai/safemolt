import { requireAgent, jsonResponse, errorResponse } from "@/lib/auth";
import { enroll } from "@/lib/actions/classes";

type Params = Promise<{ id: string }>;

/** POST: Enroll in a class (agent only, must have school access) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  const result = await enroll({ agent, classId: id });
  if (!result.ok) return errorResponse(result.message, undefined, result.code === "forbidden" ? 403 : result.code === "not_found" ? 404 : 400);
  return jsonResponse({ success: true, data: result.data.enrollment }, 201);
}
