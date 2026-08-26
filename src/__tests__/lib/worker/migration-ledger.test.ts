/**
 * M11-2 u6 P3.1 — the worker's migration-ledger boot check.
 *
 * `computeMissingMigrations` is pure and covered directly; `checkMigrationLedger` is covered against
 * a mocked `@/lib/db`. The real ledger, against the dev/integration database, is exercised by
 * `src/__tests__/integration/m11-2-u6-worker.test.ts`, which asserts every `REQUIRED_MIGRATIONS`
 * entry is genuinely recorded there — this file only proves the comparison logic.
 */

jest.mock("@/lib/db", () => ({
  sql: jest.fn(),
}));

import { sql } from "@/lib/db";
import { computeMissingMigrations, checkMigrationLedger, REQUIRED_MIGRATIONS } from "@/lib/worker/migration-ledger";

const mockedSql = sql as unknown as jest.Mock;

describe("computeMissingMigrations", () => {
  it("is empty when every required filename is recorded", () => {
    const recorded = new Set(["a.sql", "b.sql", "c.sql"]);
    expect(computeMissingMigrations(["a.sql", "b.sql"], recorded)).toEqual([]);
  });

  it("names exactly the missing filenames, in the required list's own order", () => {
    const recorded = new Set(["a.sql"]);
    expect(computeMissingMigrations(["a.sql", "b.sql", "c.sql"], recorded)).toEqual(["b.sql", "c.sql"]);
  });

  it("names everything when nothing is recorded", () => {
    expect(computeMissingMigrations(["a.sql", "b.sql"], new Set())).toEqual(["a.sql", "b.sql"]);
  });
});

describe("checkMigrationLedger", () => {
  beforeEach(() => {
    mockedSql.mockReset();
  });

  it("reports ok when every required filename is recorded", async () => {
    mockedSql.mockResolvedValue([{ filename: "a.sql" }, { filename: "b.sql" }]);
    const result = await checkMigrationLedger(["a.sql", "b.sql"]);
    expect(result).toEqual({ ok: true });
  });

  it("names the missing migration(s) when one is unrecorded", async () => {
    mockedSql.mockResolvedValue([{ filename: "a.sql" }]);
    const result = await checkMigrationLedger(["a.sql", "b.sql"]);
    expect(result).toEqual({ ok: false, reason: "missing_migrations", missing: ["b.sql"] });
  });

  it("names ALL of them as missing when the table answers empty", async () => {
    mockedSql.mockResolvedValue([]);
    const result = await checkMigrationLedger(["a.sql", "b.sql"]);
    expect(result).toEqual({ ok: false, reason: "missing_migrations", missing: ["a.sql", "b.sql"] });
  });
});

describe("REQUIRED_MIGRATIONS", () => {
  // A smoke check against silent truncation, not a claim about what belongs in the list — never a
  // future train's file (the worker/index.ts docs explain why).
  it("names the checked-in M11a set: event log through the worker lock", () => {
    expect(REQUIRED_MIGRATIONS).toEqual([
      "migrate-m11-events.sql",
      "migrate-m11-tick-log.sql",
      "migrate-m11-consumers.sql",
      "migrate-m11-shadow-compare.sql",
      "migrate-m11-wakeups.sql",
      "migrate-m11-worker.sql",
    ]);
  });
});
