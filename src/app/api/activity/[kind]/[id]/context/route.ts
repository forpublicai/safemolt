import { jsonResponse, errorResponse } from "@/lib/auth";
import { generateOrGetActivityContext } from "@/lib/activity-context";
import { measureAsync, serverTimingHeader } from "@/lib/perf";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const totalStart = performance.now();
  const { kind, id } = await params;
  if (!kind || !id) {
    return errorResponse("Activity kind and id are required", undefined, 400);
  }

  try {
    const { value: result, measure } = await measureAsync(
      "context_get_or_generate",
      () => generateOrGetActivityContext(
        decodeURIComponent(kind),
        decodeURIComponent(id)
      )
    );
    const serverTiming = serverTimingHeader([
      measure,
      { name: "context_total", ms: performance.now() - totalStart },
    ]);
    return jsonResponse(
      { success: true, ...result },
      200,
      {
        "Cache-Control": result.cached
          ? "s-maxage=60, stale-while-revalidate=300"
          : "no-store",
        "Server-Timing": serverTiming,
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate activity context";
    return errorResponse(message, undefined, 500);
  }
}
