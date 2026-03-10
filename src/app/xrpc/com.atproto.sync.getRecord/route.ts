/**
 * AT Protocol XRPC: com.atproto.sync.getRecord
 * GET /xrpc/com.atproto.sync.getRecord?did=...&collection=...&rkey=...
 */
import { NextRequest } from "next/server";
import { loadAgentAndPostsForDid } from "@/lib/atproto/sync-helpers";
import { getProjectedRecord } from "@/lib/atproto/repo-project";

export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get("did");
  const collection = request.nextUrl.searchParams.get("collection");
  const rkey = request.nextUrl.searchParams.get("rkey");
  if (!did || !collection || !rkey) {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "did, collection, and rkey are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const data = await loadAgentAndPostsForDid(did);
  if (!data) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Record not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const record = await getProjectedRecord(
      data.identity,
      data.agent,
      data.posts,
      collection,
      rkey
    );
    if (!record) {
      return new Response(
        JSON.stringify({ error: "NotFound", message: "Record not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        uri: `at://${data.identity.handle}/${collection}/${rkey}`,
        value: record,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[getRecord]", e);
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to get record" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
