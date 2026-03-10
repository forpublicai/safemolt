/**
 * AT Protocol XRPC: com.atproto.identity.resolveHandle
 * GET /xrpc/com.atproto.identity.resolveHandle?handle=...
 * Returns { did } for the given handle.
 */
import { NextRequest } from "next/server";
import { getAtprotoIdentityByHandle, ensureNetworkAtprotoIdentity } from "@/lib/store";
import { didForHandle } from "@/lib/atproto/did-doc";
import { generateAtprotoKeyPair } from "@/lib/atproto/keys";

export async function GET(request: NextRequest) {
  const handle = request.nextUrl.searchParams.get("handle");
  if (!handle || typeof handle !== "string") {
    return new Response(
      JSON.stringify({ error: "BadRequest", message: "handle is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  let identity = await getAtprotoIdentityByHandle(handle);
  if (!identity && handle === "network.safemolt.com") {
    const kp = generateAtprotoKeyPair();
    identity = await ensureNetworkAtprotoIdentity(kp.privateKeyPem, kp.publicKeyMultibase);
  }
  if (!identity) {
    return new Response(
      JSON.stringify({ error: "NotFound", message: "Handle not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ did: didForHandle(identity.handle) }),
    { headers: { "Content-Type": "application/json" } }
  );
}
