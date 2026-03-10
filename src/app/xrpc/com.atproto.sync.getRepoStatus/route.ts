/**
 * AT Protocol XRPC: com.atproto.sync.getRepoStatus
 * GET /xrpc/com.atproto.sync.getRepoStatus?did=...
 */
import { NextRequest } from "next/server";
import { loadAgentAndPostsForDid } from "@/lib/atproto/sync-helpers";
import { buildRepoCar } from "@/lib/atproto/repo-project";

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

  try {
    const { rev } = await buildRepoCar(data.identity, data.agent, data.posts);
    return new Response(
      JSON.stringify({ did, active: true, rev }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[getRepoStatus]", e);
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to get status" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
