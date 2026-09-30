/**
 * @jest-environment node
 */
import { getTrustedClientAddress, UNKNOWN_CLIENT_ADDRESS } from "@/lib/client-address";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/test", { headers });
}

/** Snapshot/restore the env this helper reads so cases cannot leak into one another. */
const ENV_KEYS = ["TRUSTED_PROXY_MODE", "TRUSTED_PROXY_HOPS", "VERCEL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getTrustedClientAddress — C13a proxy-trust modes", () => {
  it("direct mode with no hop count trusts no forwarded data at all", () => {
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "6.6.6.6" }))).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(getTrustedClientAddress(req({ "x-real-ip": "6.6.6.6" }))).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(getTrustedClientAddress(req({}))).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("direct mode with hops=1 takes the last element (the one the trusted proxy appended)", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("direct mode ignores forged elements beyond the hop count", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    // Caller forged 6.6.6.6 and 7.7.7.7; proxies appended 1.2.3.4 (client) then 10.0.0.1.
    expect(
      getTrustedClientAddress(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 1.2.3.4, 10.0.0.1" }))
    ).toBe("1.2.3.4");
  });

  it("direct mode resolves unknown when the chain is shorter than the hop count", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(getTrustedClientAddress(req({}))).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("managed-edge mode consumes the platform-written headers", () => {
    process.env.TRUSTED_PROXY_MODE = "managed-edge";
    expect(getTrustedClientAddress(req({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }))).toBe("1.2.3.4");
    expect(getTrustedClientAddress(req({}))).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("defaults to managed-edge when VERCEL is set", () => {
    process.env.VERCEL = "1";
    expect(getTrustedClientAddress(req({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("rejects garbage addresses into the unknown bucket", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "a".repeat(100) }))).toBe(UNKNOWN_CLIENT_ADDRESS);
    expect(getTrustedClientAddress(req({ "x-forwarded-for": "   " }))).toBe(UNKNOWN_CLIENT_ADDRESS);
  });

  it("a malformed hop count trusts nothing rather than something", () => {
    // Numeric-prefix garbage is the dangerous case (M11-1b review round 2, B5): `parseInt`
    // accepted "1junk" as 1 and truncated "2.5" to 2, so a typo'd configuration silently trusted
    // caller-supplied forwarded data and handed the attacker a fresh bucket per request.
    for (const bad of ["banana", "0", "-1", "1junk", "2.5", " ", "1e3", "+1", "0x2"]) {
      process.env.TRUSTED_PROXY_HOPS = bad;
      expect(getTrustedClientAddress(req({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe(UNKNOWN_CLIENT_ADDRESS);
    }
  });
});
