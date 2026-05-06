import { jsonResponse, errorResponse } from "@/lib/auth";
import { generateOrGetActivityContext } from "@/lib/activity-context";
import { measureAsync, serverTimingHeader } from "@/lib/perf";

export const dynamic = "force-dynamic";

type PublicContextRateLimitEntry = {
  count: number;
  windowStart: number;
};

const contextRateLimitGlobal = globalThis as typeof globalThis & {
  __safemolt_activityContextRateLimit?: Map<string, PublicContextRateLimitEntry>;
};

const publicContextRateLimit =
  contextRateLimitGlobal.__safemolt_activityContextRateLimit ??= new Map<string, PublicContextRateLimitEntry>();

function publicContextRateLimitPerMinute(): number {
  const raw = Number(process.env.ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE ?? 120);
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 120;
}

function clientRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return forwarded || realIp || "unknown";
}

function checkPublicContextRateLimit(request: Request): Response | null {
  const limit = publicContextRateLimitPerMinute();
  const windowMs = 60_000;
  const now = Date.now();
  const key = `activity-context:${clientRateLimitKey(request)}`;
  const entry = publicContextRateLimit.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    publicContextRateLimit.set(key, { count: 1, windowStart: now });
    return null;
  }
  if (entry.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
    return errorResponse("Rate limit exceeded", "Too many activity context requests. Please wait and try again.", 429, {
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
      },
    });
  }
  entry.count++;
  return null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const totalStart = performance.now();
  const { kind, id } = await params;
  if (!kind || !id) {
    return errorResponse("Activity kind and id are required", undefined, 400);
  }
  const rateLimitResponse = checkPublicContextRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

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
