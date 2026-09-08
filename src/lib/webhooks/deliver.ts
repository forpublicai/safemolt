import { createHmac } from "node:crypto";
import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import type { LookupFunction } from "node:net";

/**
 * M11b Lane W (P5.1) — outbound webhook delivery. URL hygiene, SSRF-safe DNS pinning, signed POST.
 * `node:http(s)`/`node:dns`/`node:net`/`node:crypto` only — no new dependency.
 */

/** Mirrors `requireCronAuth`'s `ALLOW_INSECURE_CRON`: inert unless NODE_ENV is not production. */
const INSECURE_LOCAL_FLAG = "WEBHOOK_ALLOW_INSECURE_LOCAL";

function insecureLocalAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env[INSECURE_LOCAL_FLAG] === "true";
}

export type UrlValidation = { ok: true } | { ok: false; reason: string };

/**
 * https + port 443 only, no userinfo, hostname present. Under the insecure-local test seam, plain
 * http:// is also allowed and its port is unconstrained (a local `node:http` receiver cannot bind
 * 443) — https under the same flag still requires 443, so the seam only widens what it must.
 */
export function validateWebhookUrl(url: string): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL is not valid" };
  }
  const httpSeam = insecureLocalAllowed() && parsed.protocol === "http:";
  if (parsed.protocol !== "https:" && !httpSeam) {
    return { ok: false, reason: "URL must use https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "URL must not carry userinfo" };
  }
  if (parsed.hostname === "") {
    return { ok: false, reason: "URL must name a hostname" };
  }
  if (!httpSeam && parsed.port !== "" && parsed.port !== "443") {
    return { ok: false, reason: "URL must use port 443" };
  }
  return { ok: true };
}

// --- SSRF-safe address classification -------------------------------------------------------------

function parseIPv4Octets(addr: string): number[] | null {
  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((p) => p > 255) ? null : parts;
}

/** Unspecified/"this network", RFC1918 private, CGNAT, link-local and multicast — table-driven to keep complexity flat. */
const V4_NON_PUBLIC_RANGES: ((a: number, b: number) => boolean)[] = [
  (a) => a === 0,
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a, b) => a === 100 && b >= 64 && b <= 127,
  (a, b) => a === 169 && b === 254,
  (a) => a >= 224 && a <= 239,
];

function isPublicIPv4Octets(o: number[], allowLoopback: boolean): boolean {
  const [a, b] = o;
  if (a === 127) return allowLoopback;
  return !V4_NON_PUBLIC_RANGES.some((matches) => matches(a, b));
}

function isPublicIPv4(addr: string, allowLoopback: boolean): boolean {
  const o = parseIPv4Octets(addr);
  return o === null ? false : isPublicIPv4Octets(o, allowLoopback);
}

/** Expands one "::"-side of an IPv6 address into 16-bit groups; a trailing group may be a dotted v4. */
function ipv6SideGroups(side: string): number[] | null {
  if (side === "") return [];
  const pieces = side.split(":");
  const out: number[] = [];
  for (const [i, piece] of pieces.entries()) {
    if (i === pieces.length - 1 && piece.includes(".")) {
      const v4 = parseIPv4Octets(piece);
      if (!v4) return null;
      out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
    out.push(parseInt(piece, 16));
  }
  return out;
}

function ipv6Groups(addr: string): number[] | null {
  const clean = addr.split("%")[0];
  if (net.isIP(clean) !== 6) return null;
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const head = ipv6SideGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = ipv6SideGroups(halves[1] ?? "");
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...Array(fill).fill(0), ...tail];
}

/** `::ffff:a.b.c.d` — its mapped v4 address, dotted-quad, or null when `g` is not IPv4-mapped. */
function ipv4MappedAddress(g: number[]): string | null {
  if (!(g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff)) return null;
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

function isIPv6Loopback(g: number[]): boolean {
  return g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
}

/** ULA fc00::/7, link-local fe80::/10, multicast ff00::/8 — table-driven to keep complexity flat. */
const V6_NON_PUBLIC_RANGES: ((first: number) => boolean)[] = [
  (first) => (first & 0xffc0) === 0xfe80,
  (first) => (first & 0xfe00) === 0xfc00,
  (first) => (first & 0xff00) === 0xff00,
];

function isPublicIPv6(addr: string, allowLoopback: boolean): boolean {
  const g = ipv6Groups(addr);
  if (!g) return false;
  const mappedV4 = ipv4MappedAddress(g);
  if (mappedV4) return isPublicIPv4(mappedV4, allowLoopback);
  if (g.every((x) => x === 0)) return false;
  if (isIPv6Loopback(g)) return allowLoopback;
  return !V6_NON_PUBLIC_RANGES.some((matches) => matches(g[0]));
}

function isPublicAddress(addr: string, allowLoopback: boolean): boolean {
  const family = net.isIP(addr);
  if (family === 4) return isPublicIPv4(addr, allowLoopback);
  if (family === 6) return isPublicIPv6(addr, allowLoopback);
  return false;
}

export type LookupAllFn = (
  hostname: string,
  options: { all: true }
) => Promise<{ address: string; family: number }[]>;

const defaultLookupAll: LookupAllFn = (hostname, options) => dns.promises.lookup(hostname, options);

/**
 * Resolves every A/AAAA record and throws unless ALL are public. Injectable resolver for tests.
 * Throws rather than returning an error union: every caller either awaits this inside a try/catch
 * (an attempt-time SSRF refusal) or lets it propagate as "delivery failed" — there is no caller that
 * needs to branch on *why* without also handling "resolution itself failed" the same way.
 */
export async function resolvePublicAddresses(
  hostname: string,
  lookupAll: LookupAllFn = defaultLookupAll
): Promise<string[]> {
  const records = await lookupAll(hostname, { all: true });
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) throw new Error("hostname resolved to no addresses");
  const allowLoopback = insecureLocalAllowed();
  for (const addr of addresses) {
    if (!isPublicAddress(addr, allowLoopback)) {
      throw new Error(`hostname resolves to a non-public address (${addr})`);
    }
  }
  return addresses;
}

// --- delivery --------------------------------------------------------------------------------------

export interface DeliverWakeupInput {
  url: string;
  secret: string;
  wakeupId: number;
  eventId: number | null;
  payload: Record<string, unknown>;
}

export interface DeliverWakeupResult {
  ok: boolean;
  status: number | null;
}

const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function buildHeaders(input: DeliverWakeupInput, body: string): Record<string, string> {
  const signature = createHmac("sha256", input.secret).update(body).digest("hex");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "X-SafeMolt-Signature": `sha256=${signature}`,
    "X-SafeMolt-Wakeup-Id": String(input.wakeupId),
  };
  if (input.eventId !== null) headers["X-SafeMolt-Event-Id"] = String(input.eventId);
  return headers;
}

/**
 * Always resolves to the pinned IP, ignoring whatever hostname Node's client asks it to look up.
 *
 * Node 20+'s Happy Eyeballs (`autoSelectFamily`, on by default) calls a custom `lookup` with
 * `options.all` and expects an ARRAY back, not the classic `(err, address, family)` triplet — so
 * this must answer both shapes, or every real request errors before it ever opens a socket.
 */
function pinnedLookup(pinnedIp: string): LookupFunction {
  const family = net.isIP(pinnedIp) === 6 ? 6 : 4;
  const impl = (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: pinnedIp, family }]);
    else callback(null, pinnedIp, family);
  };
  return impl as unknown as LookupFunction;
}

/** Resolves once, from the response's status code alone — a capped/aborted body still has a status. */
function handleResponse(res: http.IncomingMessage, resolve: (r: DeliverWakeupResult) => void): void {
  const status = res.statusCode ?? null;
  let received = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    resolve({ ok: status !== null && status >= 200 && status < 300, status });
  };
  res.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_RESPONSE_BYTES) {
      res.destroy();
      finish();
    }
  });
  res.on("end", finish);
  res.on("error", finish);
}

/**
 * POSTs the signed body to `pinnedIp` while presenting `parsed.hostname` for SNI/`Host` — the
 * pinning contract: the socket connects to a just-validated address, so a DNS rebind between resolve
 * and connect cannot matter. 3xx is never followed and counts as failure (status outside 2xx).
 */
function sendSignedRequest(
  parsed: URL,
  pinnedIp: string,
  body: string,
  headers: Record<string, string>
): Promise<DeliverWakeupResult> {
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;
  const port = parsed.port !== "" ? Number(parsed.port) : isHttps ? 443 : 80;

  return new Promise((resolvePromise) => {
    let settled = false;
    const resolve = (r: DeliverWakeupResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      resolvePromise(r);
    };

    const req = requestFn(
      {
        method: "POST",
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
        lookup: pinnedLookup(pinnedIp),
        timeout: CONNECT_TIMEOUT_MS,
        ...(isHttps ? { servername: parsed.hostname } : {}),
      },
      (res) => handleResponse(res, resolve)
    );

    req.on("timeout", () => req.destroy(new Error("connect timeout")));
    req.on("error", () => resolve({ ok: false, status: null }));

    const totalTimer = setTimeout(() => {
      req.destroy(new Error("total timeout"));
      resolve({ ok: false, status: null });
    }, TOTAL_TIMEOUT_MS);

    req.write(body);
    req.end();
  });
}

/**
 * Delivers one signed webhook POST. Re-resolves fresh (never cached from registration — DNS can
 * change between attempts) and picks the first validated address; a resolution failure is reported
 * the same as any other total failure (`status: null`), never thrown, so a caller doing
 * claim→deliver→record never needs a second error path.
 */
export async function deliverWakeup(input: DeliverWakeupInput): Promise<DeliverWakeupResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, status: null };
  }
  let addresses: string[];
  try {
    addresses = await resolvePublicAddresses(parsed.hostname);
  } catch {
    return { ok: false, status: null };
  }
  const body = JSON.stringify(input.payload);
  const headers = buildHeaders(input, body);
  return sendSignedRequest(parsed, addresses[0], body, headers);
}
