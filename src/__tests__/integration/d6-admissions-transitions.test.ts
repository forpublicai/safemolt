/**
 * M11-1b D6 `[integration]` — the admissions state machine against the real database.
 *
 * The headline gates are the two that cannot be observed without a database and a second
 * connection: the cycle-wide offer cap under genuine concurrency, and the partial unique index
 * that backstops "one pending offer per agent". Memory-mode semantics live in
 * `src/__tests__/lib/d6-admissions-transitions.test.ts`.
 *
 * A note on why offer creation is a BATCH rather than one statement, since a future reader will
 * ask: a `FOR UPDATE` inside a single statement does not make a cross-row count correct under READ
 * COMMITTED. The snapshot is taken when the statement begins, so a contender that waits on the
 * cycle lock still counts offers as they stood before the winner committed. Each statement in a
 * transaction takes a FRESH snapshot, so locking in one element and counting in a later one is
 * what closes it. The cap race below fails against the single-statement shape.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, runConcurrently } from "./helpers/concurrency";
import {
    acceptOfferAsAgentDb,
    acceptOfferAsHumanDb,
    createOfferDb,
    declineOfferAsAgentDb,
    declineOfferAsHumanDb,
    getOfferByIdDb,
} from "@/lib/admissions/store-db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-admissions-pending-offer-unique.sql";
const INDEX_NAME = "idx_admissions_offers_one_pending";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

async function seedAgent(): Promise<string> {
    const id = `d6_agent_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true)`,
        [id, `d6_key_${id}`]
    );
    return id;
}

async function seedCycle(maxOffers: number | null): Promise<string> {
    const id = `d6_cycle_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO admissions_cycles (id, name, opens_at, closes_at, target_size, max_offers, status, diversity_notes)
         VALUES ($1, 'D6 cycle', NOW(), NULL, 500, $2, 'open', '')`,
        [id, maxOffers]
    );
    return id;
}

/** An agent with a shortlisted application in `cycleId`, ready to be offered. */
async function seedShortlisted(cycleId: string): Promise<{ agent: string; app: string }> {
    const agent = await seedAgent();
    const app = `d6_app_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO admissions_applications (id, agent_id, cycle_id, state) VALUES ($1, $2, $3, 'shortlisted')`,
        [app, agent, cycleId]
    );
    return { agent, app };
}

async function seedHuman(agentId: string): Promise<string> {
    const id = `d6_human_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO human_users (id, cognito_sub, email, name) VALUES ($1, $2, NULL, 'D6 human')`,
        [id, `d6_sub_${id}`]
    );
    await pgPool().query(`INSERT INTO user_agents (user_id, agent_id, role) VALUES ($1, $2, 'owner')`, [id, agentId]);
    return id;
}

const offerFor = (applicationId: string, expiresAtIso = inHours(48)) =>
    createOfferDb({ applicationId, staffHumanId: null as unknown as string, expiresAtIso, payload: {} });

async function auditRows(offerId: string, action?: string) {
    const { rows } = await pgPool().query(
        `SELECT action, actor_type, actor_id, agent_id, application_id FROM admissions_audit
         WHERE offer_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY id`,
        [offerId, action ?? null]
    );
    return rows;
}

async function pendingCount(cycleId: string): Promise<number> {
    const { rows } = await pgPool().query(
        `SELECT count(*)::int AS c FROM admissions_offers WHERE cycle_id = $1 AND status = 'pending'`,
        [cycleId]
    );
    return rows[0].c;
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "D6 one pending offer per agent" }],
        dir: SCRIPTS_DIR,
        connectionString: process.env.POSTGRES_URL,
    });
}

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

afterAll(async () => {
    await pgPool().query("DELETE FROM admissions_audit WHERE agent_id LIKE $1", [`d6_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM admissions_offers WHERE agent_id LIKE $1", [`d6_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM admissions_applications WHERE agent_id LIKE $1", [`d6_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM admissions_cycles WHERE id LIKE $1", [`d6_cycle_${RUN}%`]);
    await pgPool().query("DELETE FROM human_users WHERE id LIKE $1", [`d6_human_${RUN}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`d6_agent_${RUN}%`]);
    // Leave the schema as this suite found it: the collision test drops the index deliberately.
    if (!(await migrationRecorded())) await runMigration();
    await closeIntegrationConnections();
});

describe("staff offer creation", () => {
    it("concurrent offers cannot exceed the cycle cap", async () => {
        // Three staff requests against a cap of TWO, on three DIFFERENT applications — the case an
        // application lock cannot serialize, and the case a single-statement cycle lock gets wrong
        // because its count runs against a snapshot older than the lock wait.
        //
        // The cycle row is HELD from a second connection while all three are issued, so every
        // contender is proven to queue on the same lock rather than happening to serialize by
        // scheduling. Starting three promises together and hoping they overlap would let the
        // pre-D6 implementation pass whenever the requests did not actually collide.
        const cycle = await seedCycle(2);
        const apps = [await seedShortlisted(cycle), await seedShortlisted(cycle), await seedShortlisted(cycle)];

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM admissions_cycles WHERE id = $1 FOR UPDATE", [cycle]);
            },
            contend: () => runConcurrently(apps.map((a) => () => offerFor(a.app))),
            contenderMarker: "d6:offer-cycle-lock",
        });

        expect(race.observedBlocked).toBe(true);
        const outcomes = race.result;
        expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
        expect(await pendingCount(cycle)).toBe(2);
        const refused = outcomes.filter((o) => !o.ok);
        expect(refused).toHaveLength(1);
        expect((refused[0] as { error: Error }).error.message).toBe("cycle_offer_cap_reached");
    });

    it("concurrent offers cannot create two pending offers for one agent", async () => {
        // Two shortlisted applications for ONE agent, in two cycles, offered at the same moment.
        // The decisive statement's NOT EXISTS refuses one; the partial unique index is the
        // structural backstop underneath it.
        const agent = await seedAgent();
        const appIds: string[] = [];
        for (const maxOffers of [null, null]) {
            const cycle = await seedCycle(maxOffers);
            const app = `d6_app_${RUN}_${(seq += 1)}`;
            await pgPool().query(
                `INSERT INTO admissions_applications (id, agent_id, cycle_id, state) VALUES ($1, $2, $3, 'shortlisted')`,
                [app, agent, cycle]
            );
            appIds.push(app);
        }

        const outcomes = await runConcurrently(appIds.map((app) => () => offerFor(app)));

        expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
        const { rows } = await pgPool().query(
            `SELECT count(*)::int AS c FROM admissions_offers WHERE agent_id = $1 AND status = 'pending'`,
            [agent]
        );
        expect(rows[0].c).toBe(1);

        // The LOSER'S ERROR, not just the row count. Two cycles mean two different cycle locks, so
        // both NOT EXISTS checks can pass and the partial unique index picks the winner — and a
        // loser that escapes as a raw 23505 makes the staff route answer 500 instead of an error
        // the caller's vocabulary already contains.
        const refused = outcomes.filter((o) => !o.ok);
        expect(refused).toHaveLength(1);
        expect((refused[0] as { error: Error }).error.message).toBe("agent_has_pending_offer");
    });

    it("does not let expired pending rows consume the cap, and releases their applications", async () => {
        const cycle = await seedCycle(1);
        const first = await seedShortlisted(cycle);
        const lapsed = await offerFor(first.app, inHours(-1));

        const second = await seedShortlisted(cycle);
        const offer = await offerFor(second.app);

        expect(offer.status).toBe("pending");
        expect((await getOfferByIdDb(lapsed.id))!.status).toBe("expired");
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [first.app]);
        expect(rows[0].state).toBe("in_pool");
    });

    it("leaves no offer/application/audit split — all three move, or none do", async () => {
        const cycle = await seedCycle(0); // cap of zero: the decisive statement must admit nothing
        const { app } = await seedShortlisted(cycle);

        await expect(offerFor(app)).rejects.toThrow("cycle_offer_cap_reached");

        expect(await pendingCount(cycle)).toBe(0);
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(rows[0].state).toBe("shortlisted"); // NOT advanced to 'offered'
        const { rows: audit } = await pgPool().query(
            `SELECT 1 FROM admissions_audit WHERE application_id = $1`,
            [app]
        );
        expect(audit).toHaveLength(0);
    });

    it("commits the offer, the application state and the audit row together", async () => {
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        const offer = await offerFor(app);

        expect(offer.status).toBe("pending");
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(rows[0].state).toBe("offered");
        expect(await auditRows(offer.id, "offer_created")).toEqual([
            expect.objectContaining({ actor_type: "staff", agent_id: agent, application_id: app }),
        ]);
    });
});

describe("decline", () => {
    async function pendingOffer() {
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        return { offer: await offerFor(app), agent, app };
    }

    it("changes nothing when the actor does not own the offer", async () => {
        const { offer, app } = await pendingOffer();
        const stranger = await seedAgent();

        expect(await declineOfferAsAgentDb(offer.id, stranger)).toBe(false);
        expect((await getOfferByIdDb(offer.id))!.status).toBe("pending");
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(rows[0].state).toBe("offered");
        expect(await auditRows(offer.id, "decline")).toHaveLength(0);
    });

    it("changes nothing against a non-pending offer, so it is not repeatable", async () => {
        const { offer, agent, app } = await pendingOffer();

        expect(await declineOfferAsAgentDb(offer.id, agent)).toBe(true);
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(rows[0].state).toBe("in_pool");
        expect(await auditRows(offer.id, "decline")).toHaveLength(1);

        expect(await declineOfferAsAgentDb(offer.id, agent)).toBe(false);
        expect(await auditRows(offer.id, "decline")).toHaveLength(1);
    });

    it("refuses a human with no link, and admits a linked one", async () => {
        const unlinked = await pendingOffer();
        const stranger = await seedAgent();
        const strangerHuman = await seedHuman(stranger);
        expect(await declineOfferAsHumanDb(unlinked.offer.id, strangerHuman)).toBe(false);
        expect((await getOfferByIdDb(unlinked.offer.id))!.status).toBe("pending");

        const linked = await seedHuman(unlinked.agent);
        expect(await declineOfferAsHumanDb(unlinked.offer.id, linked)).toBe(true);
        expect((await getOfferByIdDb(unlinked.offer.id))!.status).toBe("declined");
        expect(await auditRows(unlinked.offer.id, "decline")).toEqual([
            expect.objectContaining({ actor_type: "human", actor_id: linked }),
        ]);
    });

    it("admits exactly one of two concurrent declines", async () => {
        const { offer, agent } = await pendingOffer();
        const outcomes = await runConcurrently(
            Array.from({ length: 3 }, () => () => declineOfferAsAgentDb(offer.id, agent))
        );
        expect(outcomes.filter((o) => o.ok && o.value === true)).toHaveLength(1);
        expect(await auditRows(offer.id, "decline")).toHaveLength(1);
    });
});

describe("acceptance", () => {
    it("writes one timestamp and exactly one audit row across repeated calls", async () => {
        // The pre-D6 audit element asked only whether `accepted_at_agent IS NOT NULL`, which stays
        // true on retry — so every repeat rewrote the timestamp and appended another audit row.
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        const offer = await offerFor(app);
        await seedHuman(agent); // a human is linked, so agent acceptance alone waits

        expect(await acceptOfferAsAgentDb(offer.id, agent)).toBe("ok");
        const first = (await getOfferByIdDb(offer.id))!.acceptedAtAgent;
        expect(first).not.toBeNull();

        expect(await acceptOfferAsAgentDb(offer.id, agent)).toBe("ok");
        expect(await acceptOfferAsAgentDb(offer.id, agent)).toBe("ok");

        expect((await getOfferByIdDb(offer.id))!.acceptedAtAgent).toBe(first);
        expect(await auditRows(offer.id, "accept_agent")).toHaveLength(1);
    });

    it("finalizes exactly once, and concurrent acceptances do not double-admit", async () => {
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        const offer = await offerFor(app);
        const human = await seedHuman(agent);

        await acceptOfferAsAgentDb(offer.id, agent);
        // Both sides land at once; only one transaction can perform the pending -> fully_accepted
        // flip, and every other finalize write hangs off that flip's RETURNING.
        await runConcurrently([
            () => acceptOfferAsHumanDb(offer.id, human),
            () => acceptOfferAsHumanDb(offer.id, human),
            () => acceptOfferAsAgentDb(offer.id, agent),
        ]);

        expect((await getOfferByIdDb(offer.id))!.status).toBe("fully_accepted");
        expect(await auditRows(offer.id, "admission_finalized")).toHaveLength(1);
        expect(await auditRows(offer.id, "accept_human")).toHaveLength(1);

        const { rows } = await pgPool().query(`SELECT is_admitted FROM agents WHERE id = $1`, [agent]);
        expect(rows[0].is_admitted).toBe(true);
        const { rows: appRow } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(appRow[0].state).toBe("admitted");
    });

    it("finalizes on the agent's acceptance alone when no human is linked", async () => {
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        const offer = await offerFor(app);

        expect(await acceptOfferAsAgentDb(offer.id, agent)).toBe("ok");
        expect((await getOfferByIdDb(offer.id))!.status).toBe("fully_accepted");
        expect(await auditRows(offer.id, "admission_finalized")).toHaveLength(1);
        const { rows } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(rows[0].state).toBe("admitted");
    });

    it("refuses a human whose link is revoked AFTER its pre-check passed", async () => {
        // Revoking before the call would be passed by the pre-D6 shape too — its outer pre-check
        // would simply see no link. The window that matters is the one INSIDE the call: the
        // pre-check passes, then the link disappears, then the decisive statement runs. The agent
        // row is held from a second connection so the acceptance transaction wedges on its first
        // element, and the revoke happens in that gap.
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        const offer = await offerFor(app);
        const human = await seedHuman(agent);

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agent]);
                await holder.query(`DELETE FROM user_agents WHERE user_id = $1 AND agent_id = $2`, [human, agent]);
            },
            contend: () => acceptOfferAsHumanDb(offer.id, human),
            contenderMarker: "admissions_offers",
        });

        expect(race.result).toBe("invalid");
        expect((await getOfferByIdDb(offer.id))!.acceptedAtHuman).toBeNull();
        expect(await auditRows(offer.id, "accept_human")).toHaveLength(0);
    });
});

describe("the migration through the real runner", () => {
    it("applies clean, records, and leaves a unique PARTIAL index on agent_id", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await migrationRecorded()).toBe(true);

        const { rows } = await pgPool().query(
            // `attname` is `name`; the driver hands back an unparsed "{agent_id}" string for a
            // name[], so the cast to text[] is what makes this an array assertion rather than a
            // string one. The PREDICATE and validity are checked too — an index of this name scoped
            // `WHERE status = 'declined'`, or one left invalid by a failed build, exists and
            // enforces nothing.
            `SELECT i.indisunique, i.indisvalid, i.indisready,
                    pg_get_expr(i.indpred, i.indrelid) AS predicate,
                    (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
                      WHERE attrelid = t.oid AND attnum = ANY (i.indkey)) AS cols
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class t ON t.oid = i.indrelid
             WHERE c.relname = $1 AND t.relname = 'admissions_offers'`,
            [INDEX_NAME]
        );
        expect(rows[0]).toMatchObject({ indisunique: true, indisvalid: true, indisready: true, cols: ["agent_id"] });
        expect(String(rows[0].predicate)).toContain("'pending'");
    });

    it("expires lapsed pending rows rather than colliding on them", async () => {
        // A lapsed pending offer still occupies the agent's one slot under the partial predicate,
        // so the migration must expire it — otherwise a perfectly legitimate database fails to
        // migrate. This reconstructs that state with the index dropped.
        // The application is `offered`, which is the state production actually leaves it in once an
        // offer exists — a `shortlisted` fixture would be unreachable and would hide the corruption
        // this asserts against: expiring the stale offer must NOT release an application that still
        // carries a live one.
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        await pgPool().query(`UPDATE admissions_applications SET state = 'offered' WHERE id = $1`, [app]);
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        for (const [suffix, expiresAt] of [["stale", inHours(-2)], ["live", inHours(48)]] as const) {
            await pgPool().query(
                `INSERT INTO admissions_offers (id, agent_id, cycle_id, application_id, status, expires_at)
                 VALUES ($1, $2, $3, $4, 'pending', $5)`,
                [`d6_off_${RUN}_${suffix}`, agent, cycle, app, expiresAt]
            );
        }
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);

        await runMigration();

        expect(await migrationRecorded()).toBe(true);
        const { rows } = await pgPool().query(
            `SELECT id, status FROM admissions_offers WHERE id LIKE $1 ORDER BY id`,
            [`d6_off_${RUN}_%`]
        );
        expect(rows).toEqual([
            { id: `d6_off_${RUN}_live`, status: "pending" },
            { id: `d6_off_${RUN}_stale`, status: "expired" },
        ]);
        // The application must STILL be `offered`: a live offer stands against it.
        const { rows: appRow } = await pgPool().query(`SELECT state FROM admissions_applications WHERE id = $1`, [app]);
        expect(appRow[0].state).toBe("offered");
    });

    it("REFUSES and records nothing on a genuine collision — both rows survive", async () => {
        // Two LIVE pending offers for one agent is a decision for a human. The migration must not
        // pick a winner, and must not record itself as applied.
        const cycle = await seedCycle(null);
        const { agent, app } = await seedShortlisted(cycle);
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        for (const suffix of ["dup_a", "dup_b"]) {
            await pgPool().query(
                `INSERT INTO admissions_offers (id, agent_id, cycle_id, application_id, status, expires_at)
                 VALUES ($1, $2, $3, $4, 'pending', $5)`,
                [`d6_off_${RUN}_${suffix}`, agent, cycle, app, inHours(48)]
            );
        }
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);

        await expect(runMigration()).rejects.toMatchObject({ code: "P0001" });
        expect(await migrationRecorded()).toBe(false);
        const { rows } = await pgPool().query(
            `SELECT id FROM admissions_offers WHERE id LIKE $1 ORDER BY id`,
            [`d6_off_${RUN}_dup_%`]
        );
        expect(rows.map((r) => r.id)).toEqual([`d6_off_${RUN}_dup_a`, `d6_off_${RUN}_dup_b`]);

        // Resolve by hand, re-run: applies clean and rebuilds the index.
        await pgPool().query("UPDATE admissions_offers SET status = 'declined' WHERE id = $1", [`d6_off_${RUN}_dup_b`]);
        await runMigration();
        expect(await migrationRecorded()).toBe(true);
    });
});
