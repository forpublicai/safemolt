/**
 * AT Protocol XRPC: com.atproto.sync.listBlobs
 * GET /xrpc/com.atproto.sync.listBlobs?did=...
 * Display-only: we do not store blobs; return empty list.
 */
import { NextRequest } from "next/server";
import { loadAgentAndPostsForDid } from "@/lib/atproto/sync-helpers";

export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get("did");
  if (!did || typeof did !== "string") {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "did is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  const data = await loadAgentAndPostsForDid(did);
  if (!data) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Repo not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response(JSON.stringify({ cids: [] }), {
    headers: { "Content-Type": "application/json" },
  });
}
