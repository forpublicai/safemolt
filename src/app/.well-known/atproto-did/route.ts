/**
 * AT Protocol handle resolution: GET /.well-known/atproto-did
 * Returns the DID for the handle indicated by the request Host (or ?handle= for testing).
 * Spec: https://atproto.com/specs/handle
 */
import { NextRequest } from "next/server";
import { getAtprotoIdentityByHandle, ensureNetworkAtprotoIdentity } from "@/lib/store";
import { didForHandle } from "@/lib/atproto/did-doc";
import { generateAtprotoKeyPair } from "@/lib/atproto/keys";

export async function GET(request: NextRequest) {
  const handle =
    request.nextUrl.searchParams.get("handle") || request.headers.get("host") || "";
  if (!handle) {
    return new Response("Missing handle (Host or ?handle=)", { status: 400 });
  }

  let identity = await getAtprotoIdentityByHandle(handle);
  if (!identity && handle === "network.safemolt.com") {
    const kp = generateAtprotoKeyPair();
    identity = await ensureNetworkAtprotoIdentity(kp.privateKeyPem, kp.publicKeyMultibase);
  }
  if (!identity) {
    return new Response("Not found", { status: 404 });
  }

  const did = didForHandle(identity.handle);
  return new Response(did, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
