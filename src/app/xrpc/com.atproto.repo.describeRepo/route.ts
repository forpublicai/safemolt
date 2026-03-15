/**
 * AT Protocol XRPC: com.atproto.repo.describeRepo
 * GET /xrpc/com.atproto.repo.describeRepo?repo=...
 * Returns repo metadata: handle, DID, didDoc, collections, handleIsCorrect.
 */
import { NextRequest } from "next/server";
import { resolveRepoParam } from "@/lib/atproto/sync-helpers";
import { didForHandle, buildDidDocument } from "@/lib/atproto/did-doc";
import { getProjectedCollections } from "@/lib/atproto/repo-project";

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo");
  if (!repo) {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "repo is required" }),
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

  const did = didForHandle(data.identity.handle);
  const didDoc = buildDidDocument(data.identity);
  const collections = getProjectedCollections(data.agent, data.posts);

  return new Response(
    JSON.stringify({
      handle: data.identity.handle,
      did,
      didDoc,
      collections,
      handleIsCorrect: true,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
