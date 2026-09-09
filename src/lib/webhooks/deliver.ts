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

/**
 * Unspecified, RFC1918 private, CGNAT, link-local, multicast, reserved, benchmarking (198.18/15) and
 * the three documentation TEST-NET blocks — table-driven to keep complexity flat. F6: only a
 * global-unicast address may be dialed; everything else is a spoofable or non-routed range.
 */
const V4_NON_PUBLIC_RANGES: ((a: number, b: number, c: number) => boolean)[] = [
  (a) => a === 0,
  (a) => a === 10,
  (a, b) => a === 172 && b >= 16 && b <= 31,
  (a, b) => a === 192 && b === 168,
  (a, b) => a === 100 && b >= 64 && b <= 127,
  (a, b) => a === 169 && b === 254,
  (a) => a >= 224 && a <= 239,
  (a) => a >= 240,
  (a, b) => a === 198 && (b === 18 || b === 19),
  (a, b, c) => a === 192 && b === 0 && c === 0,
  (a, b, c) => a === 192 && b === 0 && c === 2,
  (a, b, c) => a === 198 && b === 51 && c === 100,
  (a, b, c) => a === 203 && b === 0 && c === 113,
];

function isPublicIPv4Octets(o: number[], allowLoopback: boolean): boolean {
  const [a, b, c] = o;
  if (a === 127) return allowLoopback;
  return !V4_NON_PUBLIC_RANGES.some((matches) => matches(a, b, c));
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

function embeddedIPv4(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** 64:ff9b::/96 (RFC 6052 NAT64): the last two groups carry the real IPv4 address to check. */
function nat64EmbeddedV4(g: number[]): string | null {
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return embeddedIPv4(g[6], g[7]);
  }
  return null;
}

/** 2002::/16 (RFC 3056 6to4): the next two groups carry the real IPv4 address to check. */
function sixToFourEmbeddedV4(g: number[]): string | null {
  return g[0] === 0x2002 ? embeddedIPv4(g[1], g[2]) : null;
}

/**
 * F4 round 3: special-purpose ranges INSIDE `2000::/3` that are not globally reachable (IANA IPv6
 * special registry) — the allowlist range alone is not enough, since it also contains protocol
 * assignments, benchmarking and documentation space that must still be refused.
 */
const V6_NON_PUBLIC_IN_GLOBAL: ((g: number[]) => boolean)[] = [
  (g) => g[0] === 0x2001 && g[1] === 0x0db8, // documentation 2001:db8::/32
  (g) => g[0] === 0x2001 && g[1] < 0x0200, // IETF protocol assignments 2001::/23
  (g) => g[0] === 0x3fff && g[1] < 0x1000, // documentation 3fff::/20
  (g) => g[0] === 0x5f00, // reserved 5f00::/16
];

/**
 * F5: an ALLOWLIST, not a denylist — only `2000::/3` (global unicast) is dialable. Everything else
 * (`fec0::/10`, `fe80::/10`, `fc00::/7`, `ff00::/8`, and any other reserved block) is refused by
 * simply falling outside the one range this returns true for, rather than by naming each one.
 */
function isPublicIPv6(addr: string, allowLoopback: boolean): boolean {
  const g = ipv6Groups(addr);
  if (!g) return false;
  const mappedV4 = ipv4MappedAddress(g);
  if (mappedV4) return isPublicIPv4(mappedV4, allowLoopback);
  const translatedV4 = nat64EmbeddedV4(g) ?? sixToFourEmbeddedV4(g);
  if (translatedV4) return isPublicIPv4(translatedV4, allowLoopback);
  if (g.every((x) => x === 0)) return false;
  if (isIPv6Loopback(g)) return allowLoopback;
  if ((g[0] & 0xe000) !== 0x2000) return false;
  return !V6_NON_PUBLIC_IN_GLOBAL.some((matches) => matches(g));
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
  headers: Record<string, string>,
  totalTimeoutMs: number
): Promise<DeliverWakeupResult> {
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;
  const port = parsed.port !== "" ? Number(parsed.port) : isHttps ? 443 : 80;

  return new Promise((resolvePromise) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
    };
    const resolve = (r: DeliverWakeupResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearConnectTimer();
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
        // F4: never the pooled default agent — a reused socket could still be talking to a PRIOR
        // pinned IP for this same hostname, bypassing this attempt's own DNS re-resolution.
        agent: false,
        ...(isHttps ? { servername: parsed.hostname } : {}),
      },
      (res) => handleResponse(res, resolve)
    );

    // F5: a SEPARATE connect-only bound, cleared the instant the socket connects — `req`'s own
    // `timeout` option measures inactivity for the request's whole life, so it fired on a receiver
    // that connects at once but answers slowly, misreporting a slow response as a connect failure.
    req.once("socket", (socket) => {
      connectTimer = setTimeout(() => req.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
      socket.once("connect", clearConnectTimer);
    });
    req.on("error", () => resolve({ ok: false, status: null }));

    // F6: `totalTimeoutMs` is what remains of the 10s deadline AFTER DNS — never a fresh 10s here —
    // so a slow resolution cannot let the socket phase run past the claim's own 30s lease.
    const totalTimer = setTimeout(() => {
      req.destroy(new Error("total timeout"));
      resolve({ ok: false, status: null });
    }, Math.max(totalTimeoutMs, 0));

    req.write(body);
    req.end();
  });
}

/**
 * Resolves to `null` after `ms` — the race partner that lets a slow DNS lookup lose the deadline.
 * Returns its timer handle too, so the caller can clear it once the race settles either way — an
 * uncleared timer otherwise outlives the request and leaks in a test's teardown check.
 */
function afterMs<T>(ms: number, value: T): [Promise<T>, NodeJS.Timeout] {
  let timer!: NodeJS.Timeout;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return [promise, timer];
}

/**
 * Delivers one signed webhook POST, re-validating the URL and re-resolving DNS on every attempt.
 * The 10s deadline starts BEFORE resolving (`Promise.race` against a timer): a slow resolver used to
 * be free time, letting one attempt run past the 30s claim lease and inviting a duplicate send.
 */
export async function deliverWakeup(
  input: DeliverWakeupInput,
  lookupAll?: LookupAllFn
): Promise<DeliverWakeupResult> {
  if (!validateWebhookUrl(input.url).ok) return { ok: false, status: null };
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, status: null };
  }
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const dnsPromise = resolvePublicAddresses(parsed.hostname, lookupAll);
  dnsPromise.catch(() => {}); // observed via the race below; a late rejection must not go unhandled
  const [timeoutPromise, timer] = afterMs<null>(Math.max(deadline - Date.now(), 0), null);
  let addresses: string[] | null;
  try {
    addresses = await Promise.race([dnsPromise, timeoutPromise]);
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  const remaining = deadline - Date.now();
  if (addresses === null || remaining <= 0) return { ok: false, status: null };
  const body = JSON.stringify(input.payload);
  const headers = buildHeaders(input, body);
  return sendSignedRequest(parsed, addresses[0], body, headers, remaining);
}
