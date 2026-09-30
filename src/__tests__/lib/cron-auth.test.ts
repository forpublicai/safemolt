/**
 * M11-1 C13 — the scheduled-job routes fail closed, and the set of routes that must is derived
 * from `vercel.json` rather than from a list somebody remembered to update.
 *
 * @jest-environment node
 */
jest.mock("@/lib/store", () => ({
  getAgentById: jest.fn(),
  mergeAgentMetadata: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";

import { requireCronAuth } from "@/lib/auth-cron";
import { POST as AGENT_METADATA_POST } from "@/app/api/v1/internal/agent-metadata/route";
import { GET as INTERNAL_AGENT_GET } from "@/app/api/v1/internal/agents/[id]/route";

const REPO_ROOT = join(__dirname, "..", "..", "..");

const SAVED_ENV: Record<string, string | undefined> = {};
// Not `as const`: `NODE_ENV` is a read-only literal on `process.env`'s type, so the restore loop
// has to reach it through the index signature.
const TOUCHED: string[] = [
  "CRON_SECRET",
  "ALLOW_INSECURE_CRON",
  "NODE_ENV",
  "SCHOOL_METADATA_SECRET",
  "SCHOOL_EVENT_SECRET",
];

function setEnv(key: string, value: string): void {
  (process.env as Record<string, string | undefined>)[key] = value;
}

beforeAll(() => {
  for (const key of TOUCHED) SAVED_ENV[key] = process.env[key];
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

function cronRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/internal/agent-loop", { headers });
}

describe("requireCronAuth", () => {
  it("refuses when CRON_SECRET is unset — absent configuration is not authorization", () => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_INSECURE_CRON;

    const denial = requireCronAuth(cronRequest());
    expect(denial?.status).toBe(401);
  });

  it("admits an unconfigured local run only through the explicit dev flag", () => {
    delete process.env.CRON_SECRET;
    setEnv("NODE_ENV", "development");
    process.env.ALLOW_INSECURE_CRON = "true";

    expect(requireCronAuth(cronRequest())).toBeNull();
  });

  it("keeps that dev flag inert in production", () => {
    // The flag is the one intentional way past the gate, so it must not be reachable in the
    // environment the gate exists to protect — including by someone who can set env vars there.
    delete process.env.CRON_SECRET;
    setEnv("NODE_ENV", "production");
    process.env.ALLOW_INSECURE_CRON = "true";

    expect(requireCronAuth(cronRequest())?.status).toBe(401);
  });

  it("accepts the configured bearer secret", () => {
    process.env.CRON_SECRET = "s3cret-value";
    expect(requireCronAuth(cronRequest({ authorization: "Bearer s3cret-value" }))).toBeNull();
  });

  it("refuses a wrong bearer, a missing bearer, and a prefix of the secret", () => {
    process.env.CRON_SECRET = "s3cret-value";

    expect(requireCronAuth(cronRequest({ authorization: "Bearer wrong" }))?.status).toBe(401);
    expect(requireCronAuth(cronRequest())?.status).toBe(401);
    // Length-mismatched input must not throw out of `timingSafeEqual` — it must be a plain refusal.
    expect(requireCronAuth(cronRequest({ authorization: "Bearer s3cret" }))?.status).toBe(401);
  });

  it("refuses a request bearing only x-vercel-cron, with the secret configured", () => {
    // A caller-shaped header is not a credential. Accepting it left a one-header bypass on any
    // direct or non-Vercel deployment; Vercel's managed crons send the bearer, so nothing is lost.
    process.env.CRON_SECRET = "s3cret-value";
    expect(requireCronAuth(cronRequest({ "x-vercel-cron": "1" }))?.status).toBe(401);
  });

  it("refuses x-vercel-cron when no secret is configured either", () => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_INSECURE_CRON;
    expect(requireCronAuth(cronRequest({ "x-vercel-cron": "1" }))?.status).toBe(401);
  });
});

/**
 * The scheduled targets are read from `vercel.json`, which is what the platform actually invokes.
 * A new cron entry therefore arrives here already needing the gate, instead of waiting for someone
 * to notice — and the enumeration is what stops this from being a list that drifts.
 */
const CRON_PATHS: string[] = (
  JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as {
    crons?: Array<{ path: string }>;
  }
).crons?.map((entry) => entry.path) ?? [];

describe("every vercel.json cron target is gated", () => {
  it("finds the cron entries", () => {
    expect(CRON_PATHS.length).toBeGreaterThan(0);
  });

  it.each(CRON_PATHS)("%s binds requireCronAuth and returns on its denial", (path) => {
    const file = join(REPO_ROOT, "src", "app", path.replace(/^\//, ""), "route.ts");
    const source = readFileSync(file, "utf8");

    // Quote style varies across the route tree; the import is what matters.
    expect(source).toMatch(/from ['"]@\/lib\/auth-cron['"]/);

    // Presence is not enforcement: a handler could call the helper and drop its result. Every
    // exported handler must bind the denial and early-return on it.
    const handlers = source.match(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    const bindings = [...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*requireCronAuth\s*\(/g)];
    expect(bindings.length).toBe(handlers.length);

    for (const binding of bindings) {
      const variable = binding[1];
      const guard = new RegExp(`if\\s*\\(\\s*${variable}\\s*\\)\\s*(?:return\\b|\\{[^}]*\\breturn\\b)`);
      expect([path, variable, guard.test(source.slice(binding.index))]).toEqual([path, variable, true]);
    }
  });

  it("leaves no route still carrying the fail-open helper it replaced", () => {
    for (const path of CRON_PATHS) {
      const source = readFileSync(join(REPO_ROOT, "src", "app", path.replace(/^\//, ""), "route.ts"), "utf8");
      expect(source).not.toContain("authorizeCron");
      expect(source).not.toContain("x-vercel-cron");
    }
  });
});

describe("federation routes keep their own credentials", () => {
  // Scope discipline: the cron secret authorizes scheduled jobs and nothing else. These two use
  // dedicated federation secrets on purpose — `school-federation/auth.ts` explicitly refuses the
  // broader event token for metadata writes, and a cron secret that opened them would undo that.
  const CRON_SECRET = "cron-secret-value";

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.SCHOOL_METADATA_SECRET = "metadata-secret";
    process.env.SCHOOL_EVENT_SECRET = "event-secret";
  });

  it("does not let a valid cron secret merge agent metadata", async () => {
    const response = await AGENT_METADATA_POST(
      new Request("http://localhost/api/v1/internal/agent-metadata", {
        method: "POST",
        headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "agent_1", metadata: { ao_fellow: true } }),
      })
    );

    expect(response.status).toBe(401);
  });

  it("does not let a valid cron secret read an agent through the federation route", async () => {
    const response = await INTERNAL_AGENT_GET(
      new Request("http://localhost/api/v1/internal/agents/agent_1", {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({ id: "agent_1" }) }
    );

    expect(response.status).toBe(401);
  });
});
