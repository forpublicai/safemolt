/**
 * AT Protocol XRPC: com.atproto.repo.getRecord
 * GET /xrpc/com.atproto.repo.getRecord?repo=...&collection=...&rkey=...
 * Returns a single record. `repo` can be a DID or handle.
 */
import { NextRequest } from "next/server";
import { resolveRepoParam } from "@/lib/atproto/sync-helpers";
import { getProjectedRecord, computeRecordCid } from "@/lib/atproto/repo-project";
import { didForHandle } from "@/lib/atproto/did-doc";

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo");
  const collection = request.nextUrl.searchParams.get("collection");
  const rkey = request.nextUrl.searchParams.get("rkey");
  if (!repo || !collection || !rkey) {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "repo, collection, and rkey are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const data = await resolveRepoParam(repo);
  if (!data) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Repo not found" }),
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

    const did = didForHandle(data.identity.handle);
    const cid = await computeRecordCid(record);
    return new Response(
      JSON.stringify({
        uri: `at://${did}/${collection}/${rkey}`,
        cid,
        value: record,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[repo.getRecord]", e);
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to get record" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
