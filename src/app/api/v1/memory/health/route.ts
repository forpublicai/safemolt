import { jsonResponse } from "@/lib/auth";
import { vectorHealth } from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

/**
 * Public health for operators (no auth). Optional: restrict with secret header in production.
 */
export async function GET() {
  const vectorOk = await vectorHealth();
  return jsonResponse({
    success: true,
    vector_backend: process.env.MEMORY_VECTOR_BACKEND || "mock",
    vector_ok: vectorOk,
  });
}
