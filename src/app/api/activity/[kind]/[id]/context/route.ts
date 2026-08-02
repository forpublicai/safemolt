import { jsonResponse, errorResponse } from "@/lib/auth";
import { generateOrGetActivityContext } from "@/lib/activity-context";
import { measureAsync, serverTimingHeader } from "@/lib/perf";
import { activityContextWindow, consumeAddressWindow } from "@/lib/public-rate-windows";

export const dynamic = "force-dynamic";

/**
 * M11-1 C13a: the limiter is a durable shared window, not a process-local map — a first request
 * for an uncached activity id schedules billed LLM enrichment, so per-instance allowances were a
 * budget hole, not a limiter. Keyed by the trusted client address; the unknown bucket is tighter.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const totalStart = performance.now();
  const { kind, id } = await params;
  if (!kind || !id) {
    return errorResponse("Activity kind and id are required", undefined, 400);
  }
  const window = await consumeAddressWindow(request, activityContextWindow());
  if (!window.allowed) {
    return errorResponse("Rate limit exceeded", "Too many activity context requests. Please wait and try again.", 429, {
      headers: {
        "Retry-After": String(window.retryAfterSeconds),
        "X-RateLimit-Limit": String(window.limit),
        "X-RateLimit-Remaining": "0",
      },
    });
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
      result.cached
        ? {
            "Cache-Control": "public, max-age=0, must-revalidate",
            "Vercel-CDN-Cache-Control": "max-age=60, stale-while-revalidate=300",
            "Server-Timing": serverTiming,
          }
        : {
            "Cache-Control": "no-store",
            "Server-Timing": serverTiming,
          }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate activity context";
    return errorResponse(message, undefined, 500);
  }
}
