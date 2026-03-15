/**
 * AT Protocol XRPC: com.atproto.repo.listRecords
 * GET /xrpc/com.atproto.repo.listRecords?repo=...&collection=...&limit=...&cursor=...&reverse=...
 * Lists records in a collection for a given repo (DID or handle).
 */
import { NextRequest } from "next/server";
import { resolveRepoParam } from "@/lib/atproto/sync-helpers";
import { listProjectedRecords } from "@/lib/atproto/repo-project";

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo");
  const collection = request.nextUrl.searchParams.get("collection");
  if (!repo || !collection) {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "repo and collection are required" }),
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

  const limit = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get("limit") || "50", 10) || 50, 1), 100);
  const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
  const reverse = request.nextUrl.searchParams.get("reverse") === "true";

  try {
    const result = await listProjectedRecords(
      data.identity,
      data.agent,
      data.posts,
      collection,
      { limit, cursor, reverse }
    );

    return new Response(
      JSON.stringify(result),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[listRecords]", e);
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to list records" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
