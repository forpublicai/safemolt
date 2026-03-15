/**
 * AT Protocol XRPC: com.atproto.sync.getBlob
 * GET /xrpc/com.atproto.sync.getBlob?did=...&cid=...
 * Serves projected blobs (e.g. agent avatars) by proxying from source URL.
 */
import { NextRequest } from "next/server";
import { resolveDidToIdentity } from "@/lib/atproto/sync-helpers";
import { getAtprotoBlobByCid } from "@/lib/store";

export async function GET(request: NextRequest) {
  const did = request.nextUrl.searchParams.get("did");
  const cid = request.nextUrl.searchParams.get("cid");
  if (!did || !cid) {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "did and cid are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const identity = await resolveDidToIdentity(did);
  if (!identity || !identity.agentId) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Blob not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  const blob = await getAtprotoBlobByCid(identity.agentId, cid);
  if (!blob) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Blob not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(blob.sourceUrl);
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: "NotFound", message: "Blob source unavailable" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    const bytes = await res.arrayBuffer();
    return new Response(bytes, {
      headers: {
        "Content-Type": blob.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "InternalServerError", message: "Failed to fetch blob" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
