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
 * single-window one. The two ORDERING cases are asserted at the store (the round-advance scan's own
 * order, and the arm scan's), because driving them at that scale says nothing extra about ordering;
 * every other case drives the real sweep end to end.
 *
 * **The E fix round adds four cases, one per finding**, and they share a shape the two originals do
 * not: a page that CANNOT drain on its own.
 *
 *  - finding 3: fifty due sessions whose advance FAILS keep their deadline, so the pre-fix loop
 *    re-read them, filtered them out in JavaScript, saw nothing fresh, and stopped — the session
 *    behind them was never reached;
 *  - finding 4: fifty under-subscribed lobbies are never eligible and never leave the pending set, so
 *    a single 50-row scan was a permanent wall in front of an eligible session;
 *  - finding 2: the round_opened bridge and wakeup re-arm read the NEWEST fifty actives, so the
 *    oldest un-armed session — the one whose participants have waited longest — was never armed;
 *  - finding 1: a sweep that has lost its singleton lock must claim nothing in ANY phase, the
 *    lifetime cap included (it used to be handed no signal at all).
 *
 * **E fix round 2 adds the fifth**, and it is the same shape as finding 3 in the one phase round 1
 * left alone: the round-1 prompt repair kept a single fixed page, on the recorded reasoning that a
 * repair always fills the prompt or loses to a writer that did. A candidate whose `game_id` resolves
 * to no game definition never reaches a write at all, so fifty of them are a permanent wall in front
 * of an ordinary crashed session — the deferral is closed, not re-recorded.
 *
 * The GM is mocked throughout: these cases are about which sessions each phase REACHES.
 */
// The GM is the only thing here that would leave the process: the advance and activation phases call
// it, and this suite is about which sessions those phases REACH, not about what the GM says.
jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "u6st round prompt"),
  resolveRound: jest.fn(async () => ({ narration: "u6st narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "u6st summary"),
}));
jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
  scheduleCommentMemoryIngest: jest.fn(),
  schedulePostMemoryIngest: jest.fn(),
}));

import { closeIntegrationConnections, pgPool } from "./helpers/db";
import {
  listActiveSessionsDueForRound,
  listActiveSessionsForArmScan,
  listSessionsDueForLifetimeCap,
} from "@/lib/store/playground/db";
import { findRoundOpenedEventId } from "@/lib/store/wakeups/db";
import { enforceSessionLifetimeCap, PLAYGROUND_SESSION_MAX_LIFETIME_MS } from "@/lib/playground/lifecycle";
import { runDeadlineProgressionUnlocked } from "@/lib/playground/session-manager";
import type { SessionParticipant } from "@/lib/playground/types";

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

/**
 * The general fixture the sweep-driving cases use: any status, any age, any game, its own school.
 *
 * `gameId` is what decides whether an advance SUCCEEDS or FAILS, and that is a fixture choice this
 * suite depends on: `resolveClaimedRound` throws when the game does not resolve, without writing
 * anything and without moving `round_deadline` — a failed advance that leaves the row exactly as due
 * as it found it, which is the starvation shape finding 3 is about. Only `foundation` resolves the
 * built-in TS games and only `ao` resolves the YAML ones, so a fixture that must actually advance or
 * activate names one of those two schools — and `idx_pg_sessions_one_live_per_school` then admits one
 * live session in each, which is why these cases seed at most one of each.
 */
async function seedSession(options: {
  status: "active" | "pending";
  ageMs: number;
  roundDeadlineOffsetMs?: number | null;
  gameId?: string;
  schoolId?: string;
  participants?: SessionParticipant[];
  currentRoundPrompt?: string | null;
}): Promise<string> {
  const id = nextId("session");
  const createdAt = new Date(Date.now() - options.ageMs).toISOString();
  const deadline =
    options.roundDeadlineOffsetMs === undefined || options.roundDeadlineOffsetMs === null
      ? null
      : new Date(Date.now() + options.roundDeadlineOffsetMs).toISOString();
  await pgPool().query(
    `INSERT INTO playground_sessions (id, game_id, school_id, status, participants, transcript,
                                      current_round, current_round_prompt, round_deadline, max_rounds,
                                      created_at, started_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6, $7, $8::timestamptz, 4, $9::timestamptz, $10::timestamptz)`,
    [
      id,
      options.gameId ?? "u6st-game",
      options.schoolId ?? `school_${id}`,
      options.status,
      JSON.stringify(options.participants ?? []),
      options.status === "active" ? 1 : 0,
      options.currentRoundPrompt === undefined ? "go" : options.currentRoundPrompt,
      deadline,
      createdAt,
      options.status === "active" ? createdAt : null,
    ]
  );
  return id;
}

function participants(count: number, prefix: string): SessionParticipant[] {
  return Array.from({ length: count }, (_, i) => ({
    agentId: `${prefix}_agent_${i}`,
    agentName: `${prefix}_agent_${i}`,
    status: "active" as const,
  }));
}

/**
 * Every sweep-driving case starts from "this suite owns no live rows".
 *
 * The two scan cases above leave a hundred live sessions behind on purpose, and a whole-sweep run
 * would then advance, arm and cap THEM — turning a precise "exactly one session was reached"
 * assertion into a count of somebody else's fixtures.
 *
 * **Every live session that is not this run's is retired, not merely this run's own.** These cases
 * assert on ORDERED, GLOBALLY LIMITED scans, so one leftover active row from an earlier suite (or an
 * earlier interrupted run — the `beforeAll` only reaches rows older than an hour) lands inside the
 * page under test and the assertion measures somebody else's fixture. That is exactly what happened
 * the first time this ran. Jest executes integration suites sequentially under the harness lock, so
 * a live row at this moment belongs to nobody. It also frees `foundation` and `ao`, the only two
 * schools whose games resolve and therefore the only two the advance and activation fixtures can use
 * — one live session each, per `idx_pg_sessions_one_live_per_school`.
 */
async function retireThisRunsLiveSessions(): Promise<void> {
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active') AND id NOT LIKE $1`,
    [`u6st_session_${RUN}%`]
  );
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active') AND id LIKE $1`,
    [`u6st_session_${RUN}%`]
  );
}

/** `current_round`, the observable an ADVANCE moves — a completion is not the only success. */
async function roundsOf(ids: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await pgPool().query<{ id: string; current_round: number }>(
    `SELECT id, current_round FROM playground_sessions WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, Number(r.current_round)]));
}

/** `current_round_prompt`, the observable a round-1 REPAIR fills — NULL means still stuck. */
async function promptsOf(ids: readonly string[]): Promise<Map<string, string | null>> {
  const { rows } = await pgPool().query<{ id: string; current_round_prompt: string | null }>(
    `SELECT id, current_round_prompt FROM playground_sessions WHERE id = ANY($1::text[])`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r.current_round_prompt]));
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

/**
 * u6 E fix round 1, finding 3 (MAJOR) — **a page of FAILED advances must not starve the due session
 * behind it.**
 *
 * The loop re-queried "due, oldest first" and filtered the ids it had already tried out of the answer
 * in JavaScript. A failed advance leaves `round_deadline` exactly where it was, so a page whose fifty
 * rows all failed came back identically, the filter emptied it, and the loop broke — the fifty-first
 * session was not reached by that invocation, and the next invocation would fail the same fifty
 * first. The exclusion now travels INTO the query, so the second page holds rows this pass has not
 * seen.
 *
 * The fixtures fail for a real reason and a cheap one: a session whose `game_id` resolves to nothing
 * makes `resolveClaimedRound` throw before it writes anything or calls the GM.
 */
describe("the round-advance sweep behind a full page of failures", () => {
  it("reaches the valid due session behind fifty failing ones, in the SAME sweep", async () => {
    await retireThisRunsLiveSessions();

    // Fifty due sessions that will each throw. Seeded most-overdue-first, so they own page 1 whole.
    const failing: string[] = [];
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      failing.push(
        await seedSession({
          status: "active",
          ageMs: 60_000,
          roundDeadlineOffsetMs: -(PAGE_SIZE + 10 - i) * 60_000,
          gameId: "u6st-no-such-game",
        })
      );
    }
    // The fifty-first: a real game, one participant who never acted and a deadline that has passed,
    // so the advance resolves the round through the (mocked) GM and opens round 2. One missed round
    // is not a forfeit — that takes two — so the observable is `current_round`, not a completion. Its
    // deadline is the NEWEST of the due set, which puts it exactly one row past the end of page 1.
    const valid = await seedSession({
      status: "active",
      ageMs: 60_000,
      roundDeadlineOffsetMs: -60_000,
      gameId: "pub-debate",
      schoolId: "foundation",
      participants: participants(1, "u6stvalid"),
    });

    const result = await runDeadlineProgressionUnlocked();

    const rounds = await roundsOf([...failing, valid]);
    // The whole point: the session behind the failing page was advanced by THIS invocation.
    expect(rounds.get(valid)).toBe(2);
    expect(result.advanced).toBeGreaterThanOrEqual(1);
    // And the fifty that failed are untouched — still active, still on round 1, still due, retried
    // on the next pass exactly as before this fix.
    const after = await statusesOf([...failing, valid]);
    expect(failing.filter((id) => after.get(id) !== "active")).toEqual([]);
    expect(failing.filter((id) => rounds.get(id) !== 1)).toEqual([]);
  }, 180_000);
});

/**
 * u6 E fix round 1, finding 4 (MAJOR) — **fifty ineligible lobbies must not starve an eligible one.**
 *
 * The activation repair read one 50-row page and stopped. Eligibility ("as many participants as the
 * game's `minPlayers`") is decided against the TypeScript game registry and cannot be pushed into
 * SQL, so an under-subscribed lobby never leaves this set on its own: fifty of them owned the only
 * page for as long as they existed, and an eligible session created behind them was never activated
 * by the sweep at all. Paging with the same attempted-exclusion is the fix.
 */
describe("the pending-activation sweep behind a full page of ineligible lobbies", () => {
  it("activates the eligible session sitting behind fifty under-subscribed ones", async () => {
    await retireThisRunsLiveSessions();

    // Fifty older, empty lobbies — permanently ineligible, and ordered ahead of the eligible one.
    const ineligible: string[] = [];
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      ineligible.push(
        await seedSession({ status: "pending", ageMs: (PAGE_SIZE + 10 - i) * 60_000, participants: [] })
      );
    }
    // The eligible one, newest: an AO YAML game (minPlayers 2) with two participants.
    const eligible = await seedSession({
      status: "pending",
      ageMs: 60_000,
      gameId: "ao-credibility-caucus",
      schoolId: "ao",
      participants: participants(2, "u6stelig"),
    });

    await runDeadlineProgressionUnlocked();

    const after = await statusesOf([...ineligible, eligible]);
    expect(after.get(eligible)).toBe("active");
    // The lobbies ahead of it are examined and left exactly as they were.
    expect(ineligible.filter((id) => after.get(id) !== "pending")).toEqual([]);
  }, 180_000);
});

/**
 * u6 E fix round 2, finding 3 (MAJOR) — **fifty repairs that cannot succeed must not starve the
 * fifty-first session.**
 *
 * The E round left this scan at one fixed page and recorded why: a repair either fills
 * `current_round_prompt` or loses to a writer that already did, so its rows drain on their own.
 * That is true only of a repair that reaches a WRITE. A candidate whose `game_id` resolves to no
 * game definition is skipped before the GM call is even made, and a candidate whose generation keeps
 * failing is logged and left exactly as due as it was found — both keep their place at the front of
 * an oldest-first queue indefinitely. Codex round 2 overturned the deferral, and this is the case
 * that closes it.
 *
 * The fifty are the cheap, deterministic form of that: an unresolvable game, so no GM call, no
 * write, no chance of leaving the set.
 */
describe("the round-1 prompt repair sweep behind a full page of unrepairable sessions", () => {
  it("repairs the session sitting behind fifty that cannot be repaired, in the SAME sweep", async () => {
    await retireThisRunsLiveSessions();

    /** `ROUND1_PROMPT_REPAIR_GRACE_MS` (`session-manager.ts`), mirrored so fixtures clear it. */
    const GRACE_MS = 2 * 60 * 1000;
    // Fifty promptless round-1 sessions the repair can never finish, seeded oldest-first so they own
    // page 1 whole. Young enough that the lifetime cap must not take them off the board instead.
    const unrepairable: string[] = [];
    for (let i = 0; i < PAGE_SIZE; i += 1) {
      unrepairable.push(
        await seedSession({
          status: "active",
          ageMs: GRACE_MS + (PAGE_SIZE + 10 - i) * 60_000,
          roundDeadlineOffsetMs: null,
          currentRoundPrompt: null,
          gameId: "u6st-no-such-game",
        })
      );
    }
    // The fifty-first: an ordinary session whose activation continuation crashed. Its game resolves,
    // so the (mocked) GM answers and `storeRound1PromptIfMissing` publishes. Newest of the set, which
    // puts it exactly one row past the end of page 1.
    const repairable = await seedSession({
      status: "active",
      ageMs: GRACE_MS + 60_000,
      roundDeadlineOffsetMs: null,
      currentRoundPrompt: null,
      gameId: "pub-debate",
      schoolId: "foundation",
      participants: participants(1, "u6strep"),
    });

    await runDeadlineProgressionUnlocked();

    const prompts = await promptsOf([...unrepairable, repairable]);
    // The whole point: the session behind the unrepairable page was repaired by THIS invocation.
    expect(prompts.get(repairable)).toBe("u6st round prompt");
    // And the fifty in front of it are untouched — still promptless, still candidates, retried on
    // the next pass exactly as before this fix.
    expect(unrepairable.filter((id) => prompts.get(id) !== null)).toEqual([]);
  }, 180_000);
});

/**
 * u6 E fix round 1, finding 2 (MAJOR) — **the round_opened bridge and the wakeup re-arm pass read the
 * OLDEST active sessions, not the newest fifty.**
 *
 * That pass is the zero-forfeit machinery: it gives an active, prompted round a `round_opened` event
 * and arms a wakeup for every participant who has not acted. Reading `listPlaygroundSessions({status:
 * 'active', limit: 50})` meant that past fifty live sessions the OLDEST un-armed one — the one whose
 * participants have been waiting longest — was outside the window on every single sweep.
 */
describe("the round_opened bridge / wakeup arm pass across more active sessions than one page", () => {
  it("reaches the oldest active session, which a newest-first window never would", async () => {
    await retireThisRunsLiveSessions();

    const POPULATION_ARM = PAGE_SIZE + 5;
    const sessions: string[] = [];
    for (let i = 0; i < POPULATION_ARM; i += 1) {
      // Seeded oldest-first and young enough that the lifetime cap must not touch any of them.
      sessions.push(
        await seedSession({
          status: "active",
          ageMs: (POPULATION_ARM - i) * 60_000,
          roundDeadlineOffsetMs: null,
          currentRoundPrompt: "go",
        })
      );
    }

    // Half 1, at the store: page 1 holds the OLDEST fifty, and the exclusion is what makes page 2
    // hold the remaining five rather than the same fifty again.
    const firstPage = await listActiveSessionsForArmScan(PAGE_SIZE);
    expect(firstPage.map((s) => s.id)).toEqual(sessions.slice(0, PAGE_SIZE));
    const secondPage = await listActiveSessionsForArmScan(PAGE_SIZE, firstPage.map((s) => s.id));
    expect(secondPage.map((s) => s.id)).toEqual(sessions.slice(PAGE_SIZE, POPULATION_ARM));

    // Half 2, end to end: one sweep gives EVERY one of them its synthetic round_opened — the oldest
    // included, which is the row a newest-first window of fifty could never contain.
    await runDeadlineProgressionUnlocked();

    const eventIds = await Promise.all(sessions.map((id) => findRoundOpenedEventId(id, 1)));
    expect(eventIds[0]).not.toBeNull();
    expect(eventIds.filter((id) => id === null)).toEqual([]);
  }, 240_000);
});

/**
 * u6 E fix round 1, finding 1 (BLOCKER) — **a sweep that has lost its lock claims nothing, in ANY
 * phase.**
 *
 * `isLockLost` was checked before each page of the round-advance loop and between phases, and the
 * lifetime-cap sweep was handed no signal at all. This case is the whole-sweep version of the
 * property: with the signal already true, one fixture per phase — a due round, a session past its
 * lifetime cap, an eligible lobby, an un-armed active session and an expirable lobby — must all be
 * exactly where they were. The second half is what makes the first half mean anything: the same
 * fixtures, swept again with no signal, all move.
 *
 * The per-claim granularity ("session A finishes, session B is never claimed") is pinned at unit
 * level, against the cap sweep, in `src/__tests__/lib/playground/lifecycle.test.ts`.
 */
describe("a deadline sweep whose lock is already lost", () => {
  it("claims nothing in any phase — and the same fixtures all move when the signal is absent", async () => {
    await retireThisRunsLiveSessions();

    const dueRound = await seedSession({
      status: "active",
      ageMs: 60_000,
      roundDeadlineOffsetMs: -60_000,
      gameId: "pub-debate",
      schoolId: "foundation",
      participants: participants(1, "u6stlock"),
    });
    const pastCap = await seedSession({
      status: "active",
      ageMs: PLAYGROUND_SESSION_MAX_LIFETIME_MS * 2,
      roundDeadlineOffsetMs: null,
    });
    const eligibleLobby = await seedSession({
      status: "pending",
      ageMs: 60_000,
      gameId: "ao-credibility-caucus",
      schoolId: "ao",
      participants: participants(2, "u6stlock2"),
    });
    const unArmed = await seedSession({
      status: "active",
      ageMs: 120_000,
      roundDeadlineOffsetMs: null,
      currentRoundPrompt: "go",
    });
    const expirable = await seedSession({ status: "pending", ageMs: 25 * 60 * 60 * 1000 });
    const all = [dueRound, pastCap, eligibleLobby, unArmed, expirable];
    const before = await statusesOf(all);

    // Half 1: the lock is gone before the first claim.
    const stopped = await runDeadlineProgressionUnlocked(() => true);
    expect(stopped).toMatchObject({ advanced: 0, capped: 0 });

    const afterStopped = await statusesOf(all);
    expect(all.map((id) => afterStopped.get(id))).toEqual(all.map((id) => before.get(id)));
    // The due round is still on the round it was due for — the advance phase claimed nothing either.
    expect((await roundsOf([dueRound])).get(dueRound)).toBe(1);
    // The bridge is the one phase whose effect is not a status: it emitted nothing either.
    expect(await findRoundOpenedEventId(unArmed, 1)).toBeNull();

    // Half 2: every one of those fixtures WAS claimable — which is what makes the nulls above a
    // property of the signal rather than of the fixtures.
    await runDeadlineProgressionUnlocked();

    const afterRun = await statusesOf(all);
    // An advance opens the next round rather than completing the session (one missed round is not a
    // forfeit), so the round number is what moves here.
    expect((await roundsOf([dueRound])).get(dueRound)).toBe(2);
    expect(afterRun.get(pastCap)).toBe("completed");
    expect(afterRun.get(eligibleLobby)).toBe("active");
    expect(afterRun.get(expirable)).toBe("cancelled");
    expect(await findRoundOpenedEventId(unArmed, 1)).not.toBeNull();
  }, 180_000);
});
