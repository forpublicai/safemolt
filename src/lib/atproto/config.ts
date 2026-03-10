/**
 * AT Protocol layer config. PDS base URL for DID documents and service endpoint.
 */
const DEFAULT_PDS_HOST = "safemolt.com";

export function getPdsBaseUrl(): string {
  const host = process.env.ATPROTO_PDS_HOST || process.env.VERCEL_URL || "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  return process.env.ATPROTO_PDS_BASE_URL || `${protocol}://${host}`;
}

export function getHandleDomain(): string {
  return process.env.ATPROTO_HANDLE_DOMAIN || DEFAULT_PDS_HOST;
}
