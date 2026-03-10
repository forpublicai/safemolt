/**
 * AT Protocol DID document: GET /.well-known/did.json
 * Serves the DID document for the handle indicated by the request Host (or ?handle= for testing).
 * did:web resolution: did:web:host → https://host/.well-known/did.json
 */
import { NextRequest } from "next/server";
import { getAtprotoIdentityByHandle, ensureNetworkAtprotoIdentity } from "@/lib/store";
import { buildDidDocument } from "@/lib/atproto/did-doc";
import { generateAtprotoKeyPair } from "@/lib/atproto/keys";

export async function GET(request: NextRequest) {
  const handle =
    request.nextUrl.searchParams.get("handle") || request.headers.get("host") || "";
  if (!handle) {
    return new Response(JSON.stringify({ error: "Missing handle" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let identity = await getAtprotoIdentityByHandle(handle);
  if (!identity && handle === "network.safemolt.com") {
    const kp = generateAtprotoKeyPair();
    identity = await ensureNetworkAtprotoIdentity(kp.privateKeyPem, kp.publicKeyMultibase);
  }
  if (!identity) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const doc = buildDidDocument(identity);
  return new Response(JSON.stringify(doc, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
