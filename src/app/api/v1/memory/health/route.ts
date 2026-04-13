import { jsonResponse } from "@/lib/auth";
import {
  vectorHealth,
  vectorBackendId,
  chromaCollectionPattern,
  embeddingModelLabel,
} from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

/**
 * Public health for operators (no auth). Optional: restrict with secret header in production.
 */
export async function GET() {
  const vectorOk = await vectorHealth();
  return jsonResponse({
    success: true,
    vector_backend: vectorBackendId(),
    vector_ok: vectorOk,
    embedding_model: embeddingModelLabel(),
    chroma_collection_pattern: vectorBackendId() === "chroma" ? chromaCollectionPattern() : undefined,
  });
}
