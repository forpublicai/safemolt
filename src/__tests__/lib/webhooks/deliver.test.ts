/**
 * M11b Lane W (P5.1) — characterizes `deliver.ts`'s real behavior: URL hygiene, SSRF-safe address
 * resolution against an INJECTED resolver (never real DNS), and the signed-POST path against a real
 * local `node:http` receiver (no mocking of `node:http`/`node:https`).
 *
 * @jest-environment node
 */
import { createHmac } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  deliverWakeup,
  resolvePublicAddresses,
  validateWebhookUrl,
  type LookupAllFn,
} from "@/lib/webhooks/deliver";

// Baseline every test to a known env, and never leak into other test files sharing this worker.
// `NODE_ENV` is a read-only literal on `process.env`'s type (house convention: `cron-auth.test.ts`),
// so every touch here goes through this index-signature cast.
const mutableEnv = process.env as Record<string, string | undefined>;
let savedFlag: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedFlag = mutableEnv.WEBHOOK_ALLOW_INSECURE_LOCAL;
  savedNodeEnv = mutableEnv.NODE_ENV;
  delete mutableEnv.WEBHOOK_ALLOW_INSECURE_LOCAL;
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete mutableEnv[key];
  else mutableEnv[key] = value;
}

afterEach(() => {
  restoreEnv("WEBHOOK_ALLOW_INSECURE_LOCAL", savedFlag);
  restoreEnv("NODE_ENV", savedNodeEnv);
});

describe("validateWebhookUrl — URL hygiene", () => {
  const cases: [string, string, boolean][] = [
    ["https + explicit 443", "https://example.com:443/hook", true],
    ["https, no port", "https://example.com/hook", true],
    ["https + 8443 (non-443)", "https://example.com:8443/hook", false],
    ["userinfo present", "https://user:pass@example.com/hook", false],
    ["empty hostname", "https://", false],
    ["malformed", "not a url", false],
  ];

  it.each(cases)("%s", (_label, url, expectOk) => {
    expect(validateWebhookUrl(url).ok).toBe(expectOk);
  });

  it("rejects plain http when the insecure-local seam is unset", () => {
    expect(validateWebhookUrl("http://127.0.0.1:9/hook").ok).toBe(false);
  });

  it("rejects plain http when the seam flag is explicitly false", () => {
    process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = "false";
    expect(validateWebhookUrl("http://127.0.0.1:9/hook").ok).toBe(false);
  });

  it("accepts plain http only under the insecure-local seam (flag true, non-production)", () => {
    process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = "true";
    mutableEnv.NODE_ENV = "development";
    expect(validateWebhookUrl("http://127.0.0.1:9/hook").ok).toBe(true);
  });

  it("keeps the seam inert in production even with the flag set", () => {
    process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = "true";
    mutableEnv.NODE_ENV = "production";
    expect(validateWebhookUrl("http://127.0.0.1:9/hook").ok).toBe(false);
  });
});

describe("resolvePublicAddresses — rejection table (injected resolver, no real DNS)", () => {
  function fakeLookup(addresses: { address: string; family: number }[]): LookupAllFn {
    return async () => addresses;
  }

  const rejected: [string, string, number][] = [
    ["loopback v4", "127.0.0.1", 4],
    ["loopback v6", "::1", 6],
    ["link-local v4", "169.254.1.1", 4],
    ["link-local v6", "fe80::1", 6],
    ["private 10/8", "10.0.0.1", 4],
    ["private 172.16/12", "172.16.0.1", 4],
    ["private 192.168/16", "192.168.1.1", 4],
    ["CGNAT 100.64/10", "100.64.0.1", 4],
    ["multicast v4", "224.0.0.1", 4],
    ["multicast v6", "ff02::1", 6],
    ["unspecified v4", "0.0.0.0", 4],
    ["unspecified v6", "::", 6],
    ["ULA fc00::/7", "fc00::1", 6],
    ["IPv4-mapped private", "::ffff:10.0.0.1", 6],
    // F6 additions — reserved, benchmarking and documentation ranges.
    ["reserved 240/4", "240.0.0.1", 4],
    ["broadcast", "255.255.255.255", 4],
    ["benchmarking 198.18/15", "198.18.0.1", 4],
    ["benchmarking 198.19/15", "198.19.0.1", 4],
    ["TEST-NET-1 192.0.2/24", "192.0.2.1", 4],
    ["TEST-NET-2 198.51.100/24", "198.51.100.1", 4],
    ["TEST-NET-3 203.0.113/24", "203.0.113.1", 4],
    ["IETF protocol 192.0.0/24", "192.0.0.1", 4],
    ["IPv6 unspecified ::/128", "::", 6],
    ["IPv6 documentation 2001:db8::/32", "2001:db8::1", 6],
    ["NAT64 64:ff9b::/96 wrapping a PRIVATE v4", "64:ff9b::a00:1", 6],
    ["6to4 2002::/16 wrapping a PRIVATE v4", "2002:0a00:0001::", 6],
    // F5 round 2 additions — the allowlist (`2000::/3`) must refuse these explicitly.
    ["deprecated site-local fec0::/10", "fec0::1", 6],
    ["6to4 2002::/16 wrapping PRIVATE 192.168/16", "2002:c0a8:101::", 6],
    ["NAT64 64:ff9b::/96 wrapping LOOPBACK", "64:ff9b::7f00:1", 6],
  ];

  it.each(rejected)("rejects %s (%s)", async (_label, address, family) => {
    await expect(
      resolvePublicAddresses("host.example", fakeLookup([{ address, family }]))
    ).rejects.toThrow();
  });

  it("resolves a genuinely public address", async () => {
    await expect(
      resolvePublicAddresses("host.example", fakeLookup([{ address: "93.184.216.34", family: 4 }]))
    ).resolves.toEqual(["93.184.216.34"]);
  });

  it("F5: accepts an ordinary global-unicast IPv6 address (2000::/3)", async () => {
    await expect(
      resolvePublicAddresses("host.example", fakeLookup([{ address: "2606:4700::1111", family: 6 }]))
    ).resolves.toEqual(["2606:4700::1111"]);
  });

  it("F6: translates a NAT64 address wrapping a PUBLIC v4 and accepts it", async () => {
    // 64:ff9b::5db8:d822 embeds 93.184.216.34 (0x5d=93, 0xb8=184, 0xd8=216, 0x22=34).
    await expect(
      resolvePublicAddresses("host.example", fakeLookup([{ address: "64:ff9b::5db8:d822", family: 6 }]))
    ).resolves.toEqual(["64:ff9b::5db8:d822"]);
  });

  it("rejects a MIXED list as a whole — one private address fails the whole resolution", async () => {
    await expect(
      resolvePublicAddresses(
        "host.example",
        fakeLookup([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ])
      )
    ).rejects.toThrow();
  });

  it("re-resolves fresh per call — no caching across attempts, even when DNS changes", async () => {
    const lookup: LookupAllFn = jest
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(resolvePublicAddresses("host.example", lookup)).resolves.toEqual(["93.184.216.34"]);
    await expect(resolvePublicAddresses("host.example", lookup)).rejects.toThrow();
  });
});

describe("deliverWakeup — real local receiver (no mocking of node:http/https)", () => {
  let server: http.Server | null = null;
  let received: { method: string | undefined; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];

  function startServer(
    respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<number> {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
          respond(req, res);
        });
      });
      server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    });
  }

  afterEach(async () => {
    received = [];
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  function enableSeam(): void {
    process.env.WEBHOOK_ALLOW_INSECURE_LOCAL = "true";
    mutableEnv.NODE_ENV = "test";
  }

  it("delivers a signed POST the receiver can verify end to end", async () => {
    enableSeam();
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });

    const result = await deliverWakeup({
      url: `http://127.0.0.1:${port}/hook`,
      secret: "test-secret",
      wakeupId: 42,
      eventId: 7,
      payload: { reason: "x", wakeup_id: 42, event_id: 7, subject: { a: 1 }, context_href: "/" },
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(received).toHaveLength(1);
    const [{ method, headers, body }] = received;
    expect(method).toBe("POST");
    expect(headers["x-safemolt-wakeup-id"]).toBe("42");
    expect(headers["x-safemolt-event-id"]).toBe("7");
    expect(headers["content-type"]).toBe("application/json");
    const expectedSignature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    expect(headers["x-safemolt-signature"]).toBe(expectedSignature);
  });

  it("F7: pins DNS resolution — connects to the injected address, presents the named Host", async () => {
    enableSeam();
    const port = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    // A resolver returning the loopback listener for a name that would never really resolve there —
    // proof the socket follows the RESOLVED address, not a same-string coincidence with the URL host.
    const lookupAll: LookupAllFn = async () => [{ address: "127.0.0.1", family: 4 }];

    const result = await deliverWakeup(
      {
        url: `http://my-webhook-target.example:${port}/hook`,
        secret: "s",
        wakeupId: 1,
        eventId: null,
        payload: {},
      },
      lookupAll
    );

    expect(result).toEqual({ ok: true, status: 200 });
    expect(received).toHaveLength(1);
    expect(received[0].headers.host).toBe(`my-webhook-target.example:${port}`);
  });

  it("F6: validates the URL on every attempt — a bad stored URL never reaches DNS or the socket", async () => {
    enableSeam();
    const lookupAll: LookupAllFn = jest.fn();

    // Userinfo is rejected by `validateWebhookUrl` regardless of the insecure-local seam.
    const result = await deliverWakeup(
      { url: "http://user:pass@127.0.0.1:1/hook", secret: "s", wakeupId: 1, eventId: null, payload: {} },
      lookupAll
    );

    expect(result).toEqual({ ok: false, status: null });
    expect(lookupAll).not.toHaveBeenCalled();
  });

  it("omits X-SafeMolt-Event-Id entirely when eventId is null (not an empty string)", async () => {
    enableSeam();
    const port = await startServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });

    await deliverWakeup({
      url: `http://127.0.0.1:${port}/hook`,
      secret: "s",
      wakeupId: 1,
      eventId: null,
      payload: { reason: "x", wakeup_id: 1, subject: {}, context_href: "/" },
    });

    expect(received).toHaveLength(1);
    expect("x-safemolt-event-id" in received[0].headers).toBe(false);
  });

  it("treats 3xx as a failure and never follows the redirect", async () => {
    enableSeam();
    const port = await startServer((_req, res) => {
      res.writeHead(302, { Location: "http://127.0.0.1:1/nope" });
      res.end();
    });

    const result = await deliverWakeup({
      url: `http://127.0.0.1:${port}/hook`,
      secret: "s",
      wakeupId: 1,
      eventId: null,
      payload: {},
    });

    expect(result).toEqual({ ok: false, status: 302 });
    expect(received).toHaveLength(1); // exactly one request — no chase of Location
  });

  it("F8(c): stops at the 64KB cap even against a receiver that streams forever and never ends", async () => {
    enableSeam();
    let timer: NodeJS.Timeout;
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Never calls res.end() — only the client's own cap can make this resolve. Without the cap,
      // this keeps writing until `deliverWakeup`'s 10s total timeout aborts the request instead.
      timer = setInterval(() => {
        if (res.destroyed) return;
        res.write("x".repeat(8 * 1024));
      }, 5);
    });

    const result = await deliverWakeup({
      url: `http://127.0.0.1:${port}/hook`,
      secret: "s",
      wakeupId: 1,
      eventId: null,
      payload: {},
    });
    clearInterval(timer!);

    expect(result).toEqual({ ok: true, status: 200 });
  }, 12_000);
});

describe("deliverWakeup — F6: the 10s deadline covers DNS", () => {
  it("refuses before any socket work when the resolver answers after the deadline", async () => {
    // Cleared explicitly (not left to fire): an uncleared 11s timer otherwise outlives this test.
    let resolverTimer: NodeJS.Timeout;
    const lookupAll: LookupAllFn = () =>
      new Promise((resolve) => {
        resolverTimer = setTimeout(() => resolve([{ address: "93.184.216.34", family: 4 }]), 11_000);
      });

    const start = Date.now();
    const result = await deliverWakeup(
      { url: "https://host.example/hook", secret: "s", wakeupId: 1, eventId: null, payload: {} },
      lookupAll
    );
    const elapsedMs = Date.now() - start;
    clearTimeout(resolverTimer!);

    expect(result).toEqual({ ok: false, status: null });
    // Refused at (roughly) the 10s deadline, never waiting out the resolver's own 11s delay.
    expect(elapsedMs).toBeLessThan(10_500);
  }, 15_000);
});
