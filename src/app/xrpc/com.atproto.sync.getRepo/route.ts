/**
 * AT Protocol XRPC: com.atproto.sync.getRepo
 * GET /xrpc/com.atproto.sync.getRepo?did=...
 * Returns full repo as CAR.
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
    const { car } = await buildRepoCar(data.identity, data.agent, data.posts);
    return new Response(Buffer.from(car), {
      headers: {
        "Content-Type": "application/vnd.ipld.car",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (e) {
    console.error("[getRepo]", e);
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to build repo" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
