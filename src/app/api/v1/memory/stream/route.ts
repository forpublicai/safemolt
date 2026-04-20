import { jsonResponse } from "@/lib/auth";
import { getGlobalMemoryStream } from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limitStr = url.searchParams.get("limit") || "50";
  const limit = parseInt(limitStr, 10) || 50;
  
  const stream = await getGlobalMemoryStream(limit);
  
  return jsonResponse({
    memories: stream,
  });
}
