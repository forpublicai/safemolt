/**
 * AT Protocol XRPC: com.atproto.sync.getBlob
 * GET /xrpc/com.atproto.sync.getBlob?did=...&cid=...
 * Display-only: we do not store blobs yet; return 404.
 */
import { NextRequest } from "next/server";

export async function GET(_request: NextRequest) {
  return new Response(
    JSON.stringify({ error: "NotFound", message: "Blob not found" }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}
