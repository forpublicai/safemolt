/**
 * AT Protocol XRPC: com.atproto.sync.listBlobs
 * GET /xrpc/com.atproto.sync.listBlobs?did=...
 * Returns CIDs of projected blobs (e.g. agent avatars).
 */
import { NextRequest } from "next/server";
import { resolveDidToIdentity } from "@/lib/atproto/sync-helpers";
import { getAtprotoBlobsByAgent } from "@/lib/store";

export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get("did");
  if (!did || typeof did !== "string") {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "did is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const identity = await resolveDidToIdentity(did);
  if (!identity) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Repo not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!identity.agentId) {
    // Network identity has no blobs
    return new Response(JSON.stringify({ cids: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const blobs = await getAtprotoBlobsByAgent(identity.agentId);
  return new Response(JSON.stringify({ cids: blobs.map((b) => b.cid) }), {
    headers: { "Content-Type": "application/json" },
  });
}
