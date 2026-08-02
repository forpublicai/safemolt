/**
 * M11-1 C13a `[integration]` — durable rate windows for the three unauthenticated, cost-bearing
 * endpoints, and the state-branched newsletter lifecycle.
 *
 * Every claim here is about shared state two instances observe — the exact property the
 * process-local maps this chunk replaces did not have — so a mocked `sql` cannot carry these
 * gates. Keys and emails are salted per run: windows are epoch-aligned and the reserved database
 * persists between runs, so a reused key would arrive pre-consumed and the suite would flake.
 *
 * The trusted-address helper's spoofed-chain behavior (both proxy modes, hop counts, unknown
 * fallback) is pure and lives in `src/__tests__/lib/client-address.test.ts`. The managed-edge
 * overwrite assumption is a per-environment deployment smoke check, recorded in the plan's
 * validation results — a code test cannot prove what the platform edge does.
 */
import { join } from "path";
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { runConcurrently } from "./helpers/concurrency";
import { consumeRateWindow, pruneExpiredRateWindows } from "@/lib/store/rate-windows/db";
import { subscribeNewsletter, confirmNewsletter, unsubscribeNewsletter } from "@/lib/store/newsletter/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-rate-windows.sql";

jest.mock("@/lib/email", () => ({
    isEmailConfigured: () => true,
    sendAgentRegistrationEmail: jest.fn(async () => ({ ok: true as const })),
    sendNewsletterConfirmation: jest.fn(async () => ({ ok: true as const })),
}));

// M11-1b review B7: the activity-context conversion needs a route-level test, and its enrichment
// is billed — mock it and count invocations rather than call the real LLM.
jest.mock("@/lib/activity-context", () => ({
    generateOrGetActivityContext: jest.fn(async () => ({ cached: false, summary: "ctx" })),
}));

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

afterAll(async () => {
    await closeIntegrationConnections();
});

describe("rate_windows primitive (db)", () => {
    it("admits up to the limit and denies after, inside one epoch-aligned window", async () => {
        const key = `c13a:${RUN}:basic`;
        for (let i = 0; i < 3; i++) {
            expect((await consumeRateWindow(key, 60_000, 3)).allowed).toBe(true);
        }
        const denied = await consumeRateWindow(key, 60_000, 3);
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });

    it("cross-instance: a second driver handle shares the same window and is denied", async () => {
        const key = `c13a:${RUN}:cross`;
        for (let i = 0; i < 2; i++) {
            expect((await consumeRateWindow(key, 60_000, 2)).allowed).toBe(true);
        }
        // A separate Neon HTTP handle — a different "instance" as far as state sharing goes.
        const other = neonSql();
        const rows = await other`
            INSERT INTO rate_windows (key, window_start, count)
            VALUES (${key}, to_timestamp(floor(extract(epoch FROM now()) / 60) * 60), 1)
            ON CONFLICT (key, window_start) DO UPDATE
                SET count = rate_windows.count + 1
                WHERE rate_windows.count < 2
            RETURNING count
        `;
        expect(rows.length).toBe(0);
    });

    it("concurrent consumes admit exactly the limit", async () => {
        const key = `c13a:${RUN}:race`;
        const outcomes = await runConcurrently(
            Array.from({ length: 10 }, () => () => consumeRateWindow(key, 60_000, 4))
        );
        const admitted = outcomes.filter((o) => o.ok && o.value.allowed);
        expect(admitted).toHaveLength(4);
    });

    it("prune removes only expired windows", async () => {
        const liveKey = `c13a:${RUN}:live`;
        const deadKey = `c13a:${RUN}:dead`;
        await consumeRateWindow(liveKey, 60_000, 5);
        await pgPool().query(
            `INSERT INTO rate_windows (key, window_start, count) VALUES ($1, now() - interval '3 hours', 1)`,
            [deadKey]
        );
        await pruneExpiredRateWindows(3_600_000);
        const { rows } = await pgPool().query<{ key: string }>(
            `SELECT key FROM rate_windows WHERE key = ANY($1)`,
            [[liveKey, deadKey]]
        );
        expect(rows.map((r) => r.key)).toEqual([liveKey]);
    });
});

describe("newsletter lifecycle (db upsert branches)", () => {
    function email(label: string): string {
        return `${label}.${RUN}@example.com`;
    }

    async function subscriberRow(address: string) {
        const { rows } = await pgPool().query<{
            confirmation_token: string;
            confirmed_at: Date | null;
            unsubscribed_at: Date | null;
            confirmation_sent_at: Date | null;
        }>(
            `SELECT confirmation_token, confirmed_at, unsubscribed_at, confirmation_sent_at
             FROM newsletter_subscribers WHERE email = $1`,
            [address]
        );
        return rows[0] ?? null;
    }

    /** Backdate the resend stamp so the CAS admits the next rotate-and-send. */
    async function elapseResendWindow(address: string): Promise<void> {
        await pgPool().query(
            `UPDATE newsletter_subscribers SET confirmation_sent_at = now() - interval '1 day' WHERE email = $1`,
            [address]
        );
    }

    it("active-subscriber attack gate: a resubscribe leaves token and confirmed_at byte-identical and sends nothing", async () => {
        const addr = email("active");
        const first = await subscribeNewsletter(addr);
        if (!first.shouldSend) throw new Error("first subscribe must send");
        expect(await confirmNewsletter(first.token)).toBe(true);
        await elapseResendWindow(addr); // even with the resend CAS satisfied
        const before = await subscriberRow(addr);

        const attack = await subscribeNewsletter(addr);
        expect(attack.shouldSend).toBe(false);
        expect(attack.token).toBeNull();

        const after = await subscriberRow(addr);
        expect(after!.confirmation_token).toBe(before!.confirmation_token);
        expect(after!.confirmed_at?.toISOString()).toBe(before!.confirmed_at?.toISOString());
        expect(after!.unsubscribed_at).toBeNull();
    });

    it("pending resubscribe rotates at most once per resend window", async () => {
        const addr = email("pending");
        const first = await subscribeNewsletter(addr);
        if (!first.shouldSend) throw new Error("must send");

        const suppressed = await subscribeNewsletter(addr);
        expect(suppressed.shouldSend).toBe(false);
        expect((await subscriberRow(addr))!.confirmation_token).toBe(first.token);

        await elapseResendWindow(addr);
        const rotated = await subscribeNewsletter(addr);
        expect(rotated.shouldSend).toBe(true);
        if (!rotated.shouldSend) throw new Error("unreachable");
        expect(rotated.token).not.toBe(first.token);
    });

    it("concurrent resubscribes against one pending address admit exactly one sender", async () => {
        const addr = email("raced");
        const first = await subscribeNewsletter(addr);
        if (!first.shouldSend) throw new Error("must send");
        await elapseResendWindow(addr);

        const outcomes = await runConcurrently(
            Array.from({ length: 4 }, () => () => subscribeNewsletter(addr))
        );
        const senders = outcomes.filter((o) => o.ok && o.value.shouldSend);
        expect(senders).toHaveLength(1);
    });

    it("unsubscribed stays unsubscribed through resubscribe; only re-confirmation resurrects", async () => {
        const addr = email("left");
        const first = await subscribeNewsletter(addr);
        if (!first.shouldSend) throw new Error("must send");
        await confirmNewsletter(first.token);
        await unsubscribeNewsletter(first.token);

        await elapseResendWindow(addr);
        const resub = await subscribeNewsletter(addr);
        expect(resub.shouldSend).toBe(true);
        if (!resub.shouldSend) throw new Error("unreachable");

        const mid = await subscriberRow(addr);
        expect(mid!.unsubscribed_at).not.toBeNull();
        expect(mid!.confirmed_at).toBeNull();

        expect(await confirmNewsletter(resub.token)).toBe(true);
        const done = await subscriberRow(addr);
        expect(done!.unsubscribed_at).toBeNull();
        expect(done!.confirmed_at).not.toBeNull();
    });
});

describe("registration flood (route level)", () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(() => {
        for (const k of ["TRUSTED_PROXY_MODE", "TRUSTED_PROXY_HOPS"]) savedEnv[k] = process.env[k];
        // Managed-edge so each request's x-real-ip lands in its own bucket.
        process.env.TRUSTED_PROXY_MODE = "managed-edge";
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    function registerRequest(name: string, address: string, ownerEmail?: string): Request {
        return new Request("http://localhost/api/v1/agents/register", {
            method: "POST",
            headers: { "content-type": "application/json", "x-real-ip": address },
            body: JSON.stringify({ name, ...(ownerEmail ? { owner_email: ownerEmail } : {}) }),
        });
    }

    it("many names against one owner_email from many addresses send at most the email allowance", async () => {
        const { POST } = await import("@/app/api/v1/agents/register/route");
        const { sendAgentRegistrationEmail } = jest.requireMock("@/lib/email") as {
            sendAgentRegistrationEmail: jest.Mock;
        };
        sendAgentRegistrationEmail.mockClear();

        const victim = `victim.${RUN}@example.com`;
        const results: number[] = [];
        for (let i = 0; i < 6; i++) {
            const res = await POST(registerRequest(`c13a_flood_${RUN}_${i}`, `addr-${RUN}-${i}`, victim));
            results.push(res.status);
        }
        // Every registration is admitted (distinct IP buckets)...
        expect(results.every((s) => s === 200)).toBe(true);
        // ...but mail to the one victim address is capped by the email window (default 3/hour).
        expect(sendAgentRegistrationEmail.mock.calls.length).toBe(3);
    });

    it("a single source address is capped by the IP window", async () => {
        const { POST } = await import("@/app/api/v1/agents/register/route");
        const address = `single-${RUN}`;
        let denied = 0;
        for (let i = 0; i < 31; i++) {
            const res = await POST(registerRequest(`c13a_ip_${RUN}_${i}`, address));
            if (res.status === 429) denied += 1;
        }
        expect(denied).toBe(1);
    });
});

describe("newsletter subscribe route (M11-1b review B7)", () => {
    const savedEnv: Record<string, string | undefined> = {};
    beforeAll(() => {
        savedEnv.TRUSTED_PROXY_MODE = process.env.TRUSTED_PROXY_MODE;
        process.env.TRUSTED_PROXY_MODE = "managed-edge";
    });
    afterAll(() => {
        if (savedEnv.TRUSTED_PROXY_MODE === undefined) delete process.env.TRUSTED_PROXY_MODE;
        else process.env.TRUSTED_PROXY_MODE = savedEnv.TRUSTED_PROXY_MODE;
    });

    function subscribeRequest(email: string, address: string) {
        // NextRequest-compatible: the route reads nextUrl.origin, so a full URL is required.
        const { NextRequest } = jest.requireActual("next/server") as typeof import("next/server");
        return new NextRequest("http://localhost/api/newsletter/subscribe", {
            method: "POST",
            headers: { "content-type": "application/json", "x-real-ip": address },
            body: JSON.stringify({ email }),
        });
    }

    it("sends exactly one confirmation for a fresh address and none on an immediate resubscribe — normal success shape both times", async () => {
        const { POST } = await import("@/app/api/newsletter/subscribe/route");
        const { sendNewsletterConfirmation } = jest.requireMock("@/lib/email") as { sendNewsletterConfirmation: jest.Mock };
        sendNewsletterConfirmation.mockClear();
        const email = `route.${RUN}@example.com`;

        const first = await POST(subscribeRequest(email, `nl-a-${RUN}`));
        expect(first.status).toBe(200);
        expect((await first.json()).success).toBe(true);

        // Immediate resubscribe from a DIFFERENT IP bucket: the email suppression window (and the
        // pending resend CAS) hold it to one mail, and the success shape is unchanged (anti-oracle).
        const second = await POST(subscribeRequest(email, `nl-b-${RUN}`));
        expect(second.status).toBe(200);
        expect((await second.json()).success).toBe(true);

        expect(sendNewsletterConfirmation.mock.calls.length).toBe(1);
    });
});

describe("activity-context route (M11-1b review B7)", () => {
    const savedEnv: Record<string, string | undefined> = {};
    beforeAll(() => {
        savedEnv.TRUSTED_PROXY_MODE = process.env.TRUSTED_PROXY_MODE;
        savedEnv.ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE = process.env.ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE;
        process.env.TRUSTED_PROXY_MODE = "managed-edge";
        process.env.ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE = "3";
    });
    afterAll(() => {
        for (const k of ["TRUSTED_PROXY_MODE", "ACTIVITY_CONTEXT_PUBLIC_RATE_LIMIT_PER_MINUTE"]) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    it("enumerating distinct activity ids cannot exceed the window's enrichment budget", async () => {
        const { GET } = await import("@/app/api/activity/[kind]/[id]/context/route");
        const { generateOrGetActivityContext } = jest.requireMock("@/lib/activity-context") as {
            generateOrGetActivityContext: jest.Mock;
        };
        generateOrGetActivityContext.mockClear();
        const address = `actx-${RUN}`;

        let admitted = 0;
        let denied = 0;
        for (let i = 0; i < 6; i++) {
            const req = new Request(`http://localhost/api/activity/post/id-${RUN}-${i}/context`, {
                headers: { "x-real-ip": address },
            });
            const res = await GET(req, { params: Promise.resolve({ kind: "post", id: `id-${RUN}-${i}` }) });
            if (res.status === 200) admitted += 1;
            if (res.status === 429) denied += 1;
        }
        // The durable shared window admits exactly the limit; enrichment (the billed call) is
        // invoked only for admitted requests.
        expect(admitted).toBe(3);
        expect(denied).toBe(3);
        expect(generateOrGetActivityContext.mock.calls.length).toBe(3);
    });
});

describe("C13a migration through the real runner", () => {
    // The postcondition queries below inspect the reserved DB's current shape, which stays green
    // even if the migration file is reverted (M11-1b review B6). This runs the file through the
    // real hardened runner: its DDL and its (now type-checking) postconditions must execute
    // clean, and the runner must record it. The migration is idempotent, so re-applying is a
    // no-op on the already-migrated DB.
    it("applies clean and records, executing its DDL and postconditions", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await migrate({ files: [{ file: MIGRATION_FILE, label: "C13a rate windows" }], dir: SCRIPTS_DIR, connectionString: process.env.POSTGRES_URL });
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        expect(rowCount).toBe(1);
    });
});

describe("C13a migration postconditions", () => {
    it("rate_windows exists with its composite primary key", async () => {
        const { rows } = await pgPool().query<{ cols: string[] }>(`
            SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord)
                    FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
            FROM pg_index i
            WHERE i.indrelid = 'public.rate_windows'::regclass AND i.indisprimary
        `);
        expect(rows[0]?.cols).toEqual(["key", "window_start"]);
    });

    it("newsletter_subscribers.confirmation_sent_at exists as timestamptz", async () => {
        const { rows } = await pgPool().query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'newsletter_subscribers'
               AND column_name = 'confirmation_sent_at' AND data_type = 'timestamp with time zone'`
        );
        expect(rows.length).toBe(1);
    });
});
