/**
 * M11-1 C13a — the single trusted-client-address helper.
 *
 * Every public rate-limit key derives from this function. Reading `x-forwarded-for` raw is not a
 * limiter — at a directly-exposed server every element of that chain is written by the caller, and
 * choosing a different index just picks a different attacker-supplied string. Position in a
 * forwarded chain is not authentication, so proxy trust is explicit and configured:
 *
 * - **managed-edge** (Vercel, the deployed configuration): the platform overwrites
 *   `x-real-ip`/`x-forwarded-for` at the edge, so the header is trusted *because the edge
 *   guarantees it*. That guarantee is a deployment assumption, verified by a per-environment
 *   smoke check (send a forged chain, observe the platform's value arrive), not by this code.
 * - **direct**: forwarded data is trusted only with a configured `TRUSTED_PROXY_HOPS` count,
 *   counting inward from the connection peer. Each trusted proxy appends exactly one element, so
 *   with N trusted hops the client is the Nth element from the right; anything further left is
 *   caller-supplied and ignored. With no hop count configured, no forwarded data is trusted.
 *
 * Anything unresolvable in either mode lands in the shared `"unknown"` bucket, which callers must
 * limit *more* tightly — stripping headers is never a way to buy a fresh allowance.
 */

export const UNKNOWN_CLIENT_ADDRESS = "unknown";

/** Longest textual IP is an IPv6 address (45 chars incl. IPv4-mapped); anything longer is garbage. */
const MAX_ADDRESS_LENGTH = 64;

function normalizeAddress(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH) return null;
  // A rate-limit key, not a parsed IP: reject separators/whitespace that could smuggle key parts.
  if (/[\s,;]/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function trustedProxyMode(): "managed-edge" | "direct" {
  const raw = process.env.TRUSTED_PROXY_MODE?.trim().toLowerCase();
  if (raw === "managed-edge" || raw === "direct") return raw;
  // Default: on Vercel the edge overwrites the headers; anywhere else nothing does.
  return process.env.VERCEL ? "managed-edge" : "direct";
}

function trustedProxyHops(): number | null {
  // Strict: `Number.parseInt` accepts "1junk" as 1 and truncates "2.5" to 2, so a typo'd
  // configuration would silently trust forwarded data it was never meant to (M11-1b review round
  // 2, B5). A hop count that is not exactly a positive integer trusts NOTHING — the "no silent
  // middle ground" contract this helper exists to keep.
  const raw = (process.env.TRUSTED_PROXY_HOPS || "").trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  // `^\d+$` alone is not "a number": a long enough digit string converts to Infinity.
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * The client address a rate limiter may key on, or `"unknown"`.
 *
 * Never returns caller-controlled data unless the deployment configuration says the relevant
 * header is proxy-written (managed-edge mode, or a direct-mode hop count that reaches it).
 */
export function getTrustedClientAddress(request: Request): string {
  if (trustedProxyMode() === "managed-edge") {
    // Vercel overwrites both headers at the edge; x-real-ip is the single client address.
    const real = normalizeAddress(request.headers.get("x-real-ip"));
    if (real) return real;
    const forwarded = normalizeAddress(request.headers.get("x-forwarded-for")?.split(",")[0]);
    return forwarded ?? UNKNOWN_CLIENT_ADDRESS;
  }

  const hops = trustedProxyHops();
  if (hops === null) return UNKNOWN_CLIENT_ADDRESS;

  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // With N trusted proxies the rightmost N elements were proxy-appended; the client is element
  // length-N. A shorter chain means a trusted proxy did not run — resolve to unknown, not to a
  // caller-chosen element.
  if (chain.length < hops) return UNKNOWN_CLIENT_ADDRESS;
  return normalizeAddress(chain[chain.length - hops]) ?? UNKNOWN_CLIENT_ADDRESS;
}
