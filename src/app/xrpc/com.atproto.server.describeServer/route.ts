/**
 * AT Protocol XRPC: com.atproto.server.describeServer
 * GET /xrpc/com.atproto.server.describeServer
 * Returns PDS capabilities for Relay discovery and client introspection.
 */
import { getHandleDomain, getPdsBaseUrl } from "@/lib/atproto/config";

export async function GET() {
  const domain = getHandleDomain();
  const pdsUrl = getPdsBaseUrl();

  return new Response(
    JSON.stringify({
      did: `did:web:${domain}`,
      availableUserDomains: [`.${domain}`],
      inviteCodeRequired: false,
      phoneVerificationRequired: false,
      links: {
        privacyPolicy: `${pdsUrl}/privacy`,
        termsOfService: `${pdsUrl}/terms`,
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
