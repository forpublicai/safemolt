/**
 * M11b lane M (P6.4, codex round 3 F1) `[integration]` — `listAgents(sort, "active_now", limit)`
 * must exclude hidden agents INSIDE the query, before `LIMIT`. The route's own hidden-agent
 * filter runs on the already-limited rows, so hidden agents ahead of a visible one used to
 * truncate it away. `limit` is test-only plumbing so this does not need to seed 500 rows.
 *
 * @jest-environment node
 */
import { listAgents as storeListAgents } from "@/lib/store/agents/db";

import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `b1p_${kind}_${RUN}_${(seq += 1)}`;

async function seedAgent(id: string, opts: { hidden?: boolean; ageMs: number; metadata?: unknown }): Promise<void> {
  const lastActiveAt = new Date(Date.now() - opts.ageMs).toISOString();
  const metadata = opts.metadata !== undefined ? JSON.stringify(opts.metadata) : opts.hidden ? JSON.stringify({ test: true }) : null;
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at,
                         is_vetted, last_active_at, metadata)
     VALUES ($1, $1, '', $2, 0, 0, 0, 0, 0, false, NOW(), true, $3, $4::jsonb)`,
    [id, `key_${id}`, lastActiveAt, metadata]
  );
}

// Agents that earlier suites left behind are still "active now" when the run is fast (a local
// database finishes the whole run inside the activity window), and `toEqual([visibleId])` counts
// them. Age them out so the result depends on this file's rows only.
beforeAll(async () => {
  await pgPool().query(
    `UPDATE agents SET last_active_at = NOW() - INTERVAL '1 day' WHERE id NOT LIKE $1`,
    [`%${RUN}%`]
  );
});

afterAll(async () => {
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [`%${RUN}%`]);
  await closeIntegrationConnections();
});

describe("listAgents(sort, \"active_now\", limit) — codex round 3 F1", () => {
  it("returns a visible active agent behind more hidden active agents than the limit", async () => {
    const visibleId = nextId("visible");
    // Seeded oldest so ORDER BY created_at DESC puts it last; a bare LIMIT would truncate it.
    await seedAgent(visibleId, { ageMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await seedAgent(nextId("hidden"), { hidden: true, ageMs: 30_000 - i * 1000 });
    }

    const result = await storeListAgents("recent", "active_now", 3);

    expect(result.map((a) => a.id)).toEqual([visibleId]);
  });
});

describe("listAgents(sort, \"active_now\", limit) — codex round 4 F3", () => {
  it("excludes a JSON boolean true but not a string \"true\", absent, or JSON null metadata", async () => {
    const boolTrueId = nextId("bool-true");
    const stringTrueId = nextId("string-true");
    const absentId = nextId("absent");
    const jsonNullId = nextId("json-null");
    await seedAgent(boolTrueId, { ageMs: 4000, metadata: { test: true } });
    await seedAgent(stringTrueId, { ageMs: 3000, metadata: { test: "true" } });
    await seedAgent(absentId, { ageMs: 2000 });
    await seedAgent(jsonNullId, { ageMs: 1000, metadata: { test: null } });

    const result = await storeListAgents("recent", "active_now", 10);
    const ids = result.map((a) => a.id);

    expect(ids).not.toContain(boolTrueId);
    expect(ids).toContain(stringTrueId);
    expect(ids).toContain(absentId);
    expect(ids).toContain(jsonNullId);
  });
});
