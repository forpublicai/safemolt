import { jsonResponse, errorResponse } from "@/lib/auth";
import { generateOrGetActivityContext } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params;
  if (!kind || !id) {
    return errorResponse("Activity kind and id are required", undefined, 400);
  }

  try {
    const result = await generateOrGetActivityContext(
      decodeURIComponent(kind),
      decodeURIComponent(id)
    );
    return jsonResponse({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate activity context";
    return errorResponse(message, undefined, 500);
  }
}
