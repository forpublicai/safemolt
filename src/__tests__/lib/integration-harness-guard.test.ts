/**
 * @jest-environment node
 *
 * The harness scripts are Node-side: `prepare.js` requires `pg`, which needs `TextEncoder`. This
 * suite still runs in the **default** project — it opens no connection, so `npm test` stays green
 * with no database, which is the property the integration project exists to preserve.
 */

/**
 * M11-1 C0 — the harness's refusal predicates, tested without a database.
 *
 * `decideProvisioning` is the security decision `--fresh` turns on: given only what was *observed*
 * before anything was written, may this run destroy the reserved database? It used to have no
 * equivalent — `prepare` dropped the database first and read the ownership marker afterwards, so
 * the documented `--fresh` command erased any database that merely shared the reserved name on an
 * allowlisted endpoint. Extracting the decision is what makes every combination assertable here,
 * with no fixture database to put at risk.
 *
 * `assertNoRedirectingParams` is the other half: a connection string may be validated and then, via
 * a libqp-style query parameter, connect somewhere else entirely.
 */
const { decideProvisioning, OWNER_MARKER_VALUE } = require("../../../scripts/integration/prepare");
const { assertNoRedirectingParams } = require("../../../scripts/integration/guard");

describe("decideProvisioning — what --fresh is allowed to destroy", () => {
    it("creates when the database does not exist", () => {
        expect(decideProvisioning({ exists: false, owner: null, fresh: false })).toBe("create");
        expect(decideProvisioning({ exists: false, owner: null, fresh: true })).toBe("create");
    });

    it("reuses an owned database when --fresh was not asked for", () => {
        expect(decideProvisioning({ exists: true, owner: OWNER_MARKER_VALUE, fresh: false })).toBe("reuse");
    });

    it("drops and recreates only a database carrying this harness's marker", () => {
        expect(decideProvisioning({ exists: true, owner: OWNER_MARKER_VALUE, fresh: true })).toBe("drop-and-create");
    });

    it("refuses --fresh against an unmarked database, and names the deliberate way in", () => {
        // The fixture the old code destroyed: a database that happens to be called
        // `safemolt_integration` on an allowlisted endpoint, holding somebody's data.
        expect(() => decideProvisioning({ exists: true, owner: null, fresh: true })).toThrow(
            /--fresh refuses to drop a database that carries no harness ownership marker/
        );
        expect(() => decideProvisioning({ exists: true, owner: null, fresh: true })).toThrow(/--adopt/);
    });

    it("refuses a differently-owned database whether or not --fresh was asked for", () => {
        expect(() => decideProvisioning({ exists: true, owner: "someone-elses-harness", fresh: false })).toThrow(
            /records owner 'someone-elses-harness', not this harness/
        );
        expect(() => decideProvisioning({ exists: true, owner: "someone-elses-harness", fresh: true })).toThrow(
            /records owner 'someone-elses-harness', not this harness/
        );
    });

    it("never returns a destructive action for anything it did not verify", () => {
        // Stated as an invariant over the whole input space rather than case by case, so a future
        // branch cannot quietly add a fifth combination that drops without a verified marker.
        const owners = [null, OWNER_MARKER_VALUE, "someone-else"];
        for (const exists of [true, false]) {
            for (const owner of owners) {
                for (const fresh of [true, false]) {
                    let action: string | null = null;
                    try {
                        action = decideProvisioning({ exists, owner, fresh });
                    } catch {
                        continue; // a refusal is always an acceptable outcome
                    }
                    if (action === "drop-and-create") {
                        expect(exists).toBe(true);
                        expect(owner).toBe(OWNER_MARKER_VALUE);
                        expect(fresh).toBe(true);
                    }
                }
            }
        }
    });
});

describe("assertNoRedirectingParams", () => {
    const REDIRECTING = ["host", "hostaddr", "port", "dbname", "database", "service", "passfile", "servicefile"];

    it.each(REDIRECTING)("refuses a connection string carrying '%s'", (param) => {
        const url = new URL(`postgres://u:p@ep-allowed.example.neon.tech/safemolt_integration?${param}=elsewhere`);
        expect(() => assertNoRedirectingParams(url, "POSTGRES_URL")).toThrow(
            new RegExp(`connection-redirecting parameter '${param}'`)
        );
    });

    it("allows an ordinary connection string", () => {
        const url = new URL("postgres://u:p@ep-allowed.example.neon.tech/safemolt_integration?sslmode=require");
        expect(() => assertNoRedirectingParams(url, "POSTGRES_URL")).not.toThrow();
    });
});
