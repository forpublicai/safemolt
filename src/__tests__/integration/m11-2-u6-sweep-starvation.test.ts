/**
 * M11-2 u6 stitch item 5 (f) `[integration]` — the due-scan sweeps do not STARVE across pages.
 *
 * The defect this pins is the one u6 P3.1 fixed and nothing else re-checks at scale: both sweeps used
 * to read a fixed window of the NEWEST active sessions and filter it in JavaScript, so with more live
 * sessions than the window a genuinely overdue one sat outside it on every pass — forever, while a
 * stream of newer sessions kept the window full. The remedy has two halves and both are properties of
 * a POPULATION LARGER THAN ONE PAGE, which is why this needs its own suite:
 *
 *  1. the predicate is in the QUERY and the order is DUE-ASC, so page 1 holds the sessions that have
 *     waited longest — never the newest ones;
 *  2. the sweep PAGES until a page comes back short, and a processed row leaves the due set on its
 *     own (a shrinking predicate, not an offset), so one invocation reaches all of them.
 *
 * Bounded at 2× the page size, which is the smallest population that can tell a paged sweep from a
 * single-window one. Only the LIFETIME CAP is driven end to end: it is the sweep whose per-session
 * work is a pure conditional UPDATE. The round-advance scan's own ordering is asserted at the store,
 * because driving it would mean a GM inference call per session and this suite is about starvation,
 * not about the game engine.
 */
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import {
  listActiveSessionsDueForRound,
  listSessionsDueForLifetimeCap,
} from "@/lib/store/playground/db";
import { enforceSessionLifetimeCap, PLAYGROUND_SESSION_MAX_LIFETIME_MS } from "@/lib/playground/lifecycle";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u6st_${kind}_${RUN}_${(seq += 1)}`;

/** The sweep's own page size (`lifecycle.ts`), mirrored so the fixture can deliberately exceed it. */
const PAGE_SIZE = 50;
/** 2× the page size: the smallest population a single-window sweep provably cannot finish. */
const POPULATION = PAGE_SIZE * 2;

let baselineEventId = 0;

/**
 * An ACTIVE session, aged by `ageMs`, in a school of its own.
 *
 * Each fixture needs its own school because `idx_pg_sessions_one_live_per_school` admits exactly one
 * live session per school — and this suite seeds a hundred at once, which is the whole point.
 */
async function seedActiveSession(ageMs: number, roundDeadlineOffsetMs: number | null): Promise<string> {
  const id = nextId("session");
  const startedAt = new Date(Date.now() - ageMs).toISOString();
  const deadline =
    roundDeadlineOffsetMs === null ? null : new Date(Date.now() + roundDeadlineOffsetMs).toISOString();
  await pgPool().query(
    `INSERT INTO playground_sessions (id, game_id, school_id, status, participants, transcript,
                                      current_round, current_round_prompt, round_deadline, max_rounds,
                                      created_at, started_at)
     VALUES ($1, 'u6st-game', $2, 'active', '[]'::jsonb, '[]'::jsonb, 1, 'go', $3::timestamptz, 4, $4::timestamptz, $4::timestamptz)`,
    [id, `school_${id}`, deadline, startedAt]
  );
  return id;
}

async function statusesOf(ids: readonly string[]): Promise<Map<string, string>> {
  const { rows } = await pgPool().query<{ id: string; status: string }>(
    `SELECT id, status FROM playground_sessions WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r.status]));
}

/**
 * One-per-scope index orphan neutralization. `idx_pg_sessions_one_live_per_school` is one live
 * session per school across the WHOLE table, so a run-unique suffix cannot dodge a leftover — and an
 * interrupted prior run skips `afterAll` and leaves exactly that. Every fixture here seeds its own
 * school, so only this suite's own orphans and genuinely stale live rows can be in the way.
 */
beforeAll(async () => {
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE 'u6st_session_%'`);
  await pgPool().query(`DELETE FROM activity_events WHERE entity_id LIKE 'u6st_session_%'`);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE 'u6st_session_%'`);
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u6st%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
  // The DUE SET is this suite's second shared resource, and it needs neutralizing for the same
  // reason the index does: both scans are ordered global queries with a LIMIT, so an already-due
  // leftover from another suite's interrupted run lands INSIDE the page under test and the ordering
  // assertion measures somebody else's fixtures. Pushing those deadlines out empties the due set
  // without deleting rows that a still-live suite might own; nothing is processing them anyway,
  // since a row is only in this set because its own sweep never reached it.
  await pgPool().query(
    `UPDATE playground_sessions SET round_deadline = NOW() + INTERVAL '2 days'
     WHERE status = 'active' AND round_deadline IS NOT NULL AND round_deadline <= NOW()`
  );
  const { rows } = await pgPool().query(`SELECT COALESCE(max(id), 0) AS id FROM events`);
  baselineEventId = Number(rows[0].id);
});

afterAll(async () => {
  await pgPool().query(`DELETE FROM activity_events WHERE entity_id LIKE $1`, [`u6st_session_${RUN}%`]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1`, [`u6st_session_${RUN}%`]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [`u6st_session_${RUN}%`]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await closeIntegrationConnections();
});

describe("the lifetime-cap sweep across more due sessions than one page", () => {
  it("caps EVERY overdue session in one invocation, and leaves the not-yet-due ones alone", async () => {
    const lifetimeMs = PLAYGROUND_SESSION_MAX_LIFETIME_MS;
    const overdue: string[] = [];
    for (let i = 0; i < POPULATION; i += 1) {
      // Staggered ages, all past the cap. The NEWEST overdue ones are seeded LAST, so a newest-first
      // window would fill itself with them and never reach index 0 — the exact starvation shape.
      overdue.push(await seedActiveSession(lifetimeMs * 2 - i * 1000, null));
    }
    // Young enough that the cap must not touch them, and numerous enough to fill a newest-first
    // window on their own.
    const young: string[] = [];
    for (let i = 0; i < 5; i += 1) young.push(await seedActiveSession(60_000, null));

    // Half 1: the page the sweep sees FIRST holds the sessions that have waited longest.
    const cutoff = new Date(Date.now() - lifetimeMs).toISOString();
    const firstPage = await listSessionsDueForLifetimeCap(cutoff, PAGE_SIZE);
    expect(firstPage).toHaveLength(PAGE_SIZE);
    // `overdue[0]` is the oldest of all; a fixed newest-first window would never contain it.
    expect(firstPage[0].id).toBe(overdue[0]);
    expect(firstPage.map((s) => s.id)).toEqual(overdue.slice(0, PAGE_SIZE));
    expect(firstPage.some((s) => young.includes(s.id))).toBe(false);

    // Half 2: ONE invocation pages through all of them.
    const { completed } = await enforceSessionLifetimeCap();
    expect(completed).toBeGreaterThanOrEqual(POPULATION);

    const after = await statusesOf([...overdue, ...young]);
    // Not "most of them" — every single one, which is what "none starved" means.
    expect(overdue.filter((id) => after.get(id) !== "completed")).toEqual([]);
    expect(young.filter((id) => after.get(id) !== "active")).toEqual([]);

    // And the sweep is a shrinking predicate, not an offset: a second run finds nothing to do.
    expect((await enforceSessionLifetimeCap()).completed).toBe(0);
    const stillYoung = await statusesOf(young);
    expect(young.filter((id) => stillYoung.get(id) !== "active")).toEqual([]);
  }, 120_000);
});

describe("the round-advance due scan across more overdue rounds than one page", () => {
  it("answers with the MOST-OVERDUE rounds first, never the newest active sessions", async () => {
    const overdue: string[] = [];
    for (let i = 0; i < POPULATION; i += 1) {
      // Deadline in the past, staggered: index 0 is the most overdue, seeded FIRST.
      overdue.push(await seedActiveSession(60_000, -(POPULATION - i) * 60_000));
    }
    // Live sessions whose round is NOT due — the population that used to bury the overdue ones.
    const notDue: string[] = [];
    for (let i = 0; i < 5; i += 1) notDue.push(await seedActiveSession(1_000, 60 * 60_000));

    const page = await listActiveSessionsDueForRound(PAGE_SIZE);
    expect(page).toHaveLength(PAGE_SIZE);
    expect(page.map((s) => s.id)).toEqual(overdue.slice(0, PAGE_SIZE));
    expect(page.some((s) => notDue.includes(s.id))).toBe(false);

    // The second page continues where the first stopped — the sweep's own loop re-queries after each
    // page, and a processed row leaves the due set because a successful advance moves its deadline.
    // Simulated here by removing the first page from the due set the same way an advance would.
    await pgPool().query(
      `UPDATE playground_sessions SET round_deadline = NOW() + INTERVAL '1 hour' WHERE id = ANY($1::text[])`,
      [page.map((s) => s.id)]
    );
    const secondPage = await listActiveSessionsDueForRound(PAGE_SIZE);
    expect(secondPage.map((s) => s.id)).toEqual(overdue.slice(PAGE_SIZE, POPULATION));
    expect(secondPage.some((s) => notDue.includes(s.id))).toBe(false);
  }, 120_000);
});
