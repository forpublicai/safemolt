/**
 * M11-2 u5 lane C (P3.2) deliverable 6 `[integration]` — the wakeup queue's CROSS-CUTTING races.
 *
 * Deliverables 3, 4 and 5 were each built and gated in isolation: the wakeup store against its own
 * indexes, the router and the notifications projection against hand-emitted events, and the three
 * `playground.round_opened` producers against the statements that carry them. Nothing yet proves the
 * three COMPOSE — that a real activation racing a real repair sweep, a real round advance racing a
 * real deadline sweep, and a real submission landing before a real drain, all end with the one thing
 * an agent actually experiences: **exactly one nudge per participant per round.** Never zero (a lost
 * turn), never two (a double-spent loop budget).
 *
 * Every gate below is that single invariant, observed at the end of a whole pipeline:
 *
 *  - **Scenario 1** — the activation path's fire-and-forget round-1 write and the deadline sweep's
 *    repair, both genuinely blocked on the same session row, released together: ONE prompt, ONE
 *    event, ONE wakeup and ONE notification per participant. This is the end-to-end version of the
 *    store-level race u5c pins; what it adds is the whole tail — the sweep's own arming, the drain's
 *    router and the drain's notifications projection, all keyed to a single event id.
 *  - **`no-wakeup-before-prompt`** — the window between the status flip and the publication produces
 *    NOTHING, in the queue or the inbox. A wakeup for a round with no prompt is a turn nobody can take.
 *  - **`upgrade-bridge`** — a prompted round that predates this kind is reconstructed once and armed
 *    on the SAME pass, and repeated passes converge rather than accumulate.
 *  - **`late-recovery`** — a repair long past the grace stamps the clock from the repair, not from
 *    the session's birth, and forfeits nobody for having waited.
 *  - **`stale-round-event`** — an event for a round a REAL advance has already closed is a receipt
 *    and nothing else, while the advance's own event is the one that nudges.
 *  - **`early-actor`** — a submission that lands before the drain removes exactly its author from the
 *    recipient set, on both projections.
 *  - **`submit-vs-deadline`** — two real resolvers blocked on one session row settle to exactly one
 *    transition and exactly one `round_opened`.
 *  - **`advance-vs-completion`** — a completion fenced on a round the session has left matches zero
 *    rows, writes nothing and emits nothing, with a control proving the fixture could have won.
 *  - **the sweep's re-arm across rounds** — an 'acted' wakeup from a prior round is left alone while
 *    the new round gets a fresh row, because the dedup triple is keyed on the EVENT.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

/**
 * `safeWaitUntil` hands its tagged promise to `waitUntil` and returns void, so the activation's
 * round-1 write and the submit's round advance are unreachable from a caller. Mocking the ONE
 * external function it delegates to (the precedent is `c22-certification-lifecycle.test.ts`) makes
 * both promises observable without touching production: `waitUntil.mock.calls[n][0]` IS the promise
 * production is deferring, so "the fire-and-forget write has settled" becomes an `await` rather than
 * a sleep. Nothing about the write itself changes.
 */
jest.mock("@vercel/functions", () => ({ waitUntil: jest.fn() }));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "generated prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

// Embedding is an outbound HTTP call the resolution path makes per participant. It degrades rather
// than fails, but a real attempt would make this suite depend on a token and on latency.
jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

import { waitUntil } from "@vercel/functions";

import { joinSession, submitAction } from "@/lib/actions/playground";
import { playgroundSessionCompletedEvent } from "@/lib/actions/playground-events";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { generateRoundPrompt } from "@/lib/playground/engine";
import { runDeadlineProgressionUnlocked, tryAdvanceRound } from "@/lib/playground/session-manager";
import { emitEvent } from "@/lib/store";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import {
  applyPlaygroundResolution,
  claimPlaygroundResolution,
  createPlaygroundSession,
  getPlaygroundSession,
} from "@/lib/store/playground/db";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { PlaygroundSession, SessionParticipant } from "@/lib/playground/types";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { activateRealConsumers } from "./helpers/activate-consumers";
import { closeIntegrationConnections, pgClient, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u5d${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);
const PLAYGROUND_ROUND = "playground_round";
const ROUND_OPEN = "playground_round_open";

/** `ACTION_TIMEOUT_MS` in `session-manager.ts`; not exported, and pinned here on purpose. */
const ROUND_MS = 60 * 60 * 1000;
/** `ROUND1_PROMPT_REPAIR_GRACE_MS` in `session-manager.ts`; likewise not exported. */
const REPAIR_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_PROMPT = "generated prompt";

/**
 * Substrings of the two statements this file races, matched against `pg_stat_activity.query`.
 *
 * Neither carries an SQL comment marker of its own, and this deliverable is test-only — production
 * SQL is not edited to make a test easier to write. A verbatim fragment of the statement identifies
 * the backend just as precisely as a comment would, and `strpos` is an exact substring test rather
 * than `LIKE`, whose `_` would match any character inside these column names.
 */
const PROMPT_PUBLISH_FRAGMENT = "SET current_round_prompt = $2::text";
const RESOLUTION_CLAIM_FRAGMENT = "SET resolve_claim_token = $1";

const generateRoundPromptMock = generateRoundPrompt as unknown as jest.Mock;
const waitUntilMock = waitUntil as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// GM-latency control
// ---------------------------------------------------------------------------

interface Gate {
  opened: Promise<void>;
  open: () => void;
}

/** Sessions whose prompt generation is parked, and how many times each has been asked. */
const gates = new Map<string, Gate>();
const promptCalls = new Map<string, number>();

/**
 * Park every `generateRoundPrompt` for ONE session until `open()`.
 *
 * Scoped by session id deliberately: the deadline sweep walks every active session in the database,
 * and a global gate would deadlock the sweep on somebody else's fixture.
 */
function gateSession(sessionId: string): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  const gate: Gate = { opened, open };
  gates.set(sessionId, gate);
  return gate;
}

async function waitForPromptCalls(sessionId: string, count: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((promptCalls.get(sessionId) ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `[u5d] generateRoundPrompt was asked ${promptCalls.get(sessionId) ?? 0} time(s) for ${sessionId}, expected ${count}`
  );
}

/**
 * How many backends are blocked while running the statement `fragment` names.
 *
 * Counts backends blocked by ANYONE rather than by one holder: PostgreSQL QUEUES row-lock waiters,
 * so the second contender is blocked by the first rather than directly by the holder (the idiom
 * `m11-2-u3f-core-classes.test.ts` records for the enroll-cap race). Wall-clock ordering is never
 * the basis — this is read from the catalog or it is zero.
 */
async function waitForBlockedBackends(
  fragment: string,
  atLeast: number,
  timeoutMs = 8_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const { rows } = await pgPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND cardinality(pg_blocking_pids(pid)) > 0
         AND strpos(query, $1) > 0`,
      [fragment]
    );
    seen = Math.max(seen, rows[0].n);
    if (seen >= atLeast) return seen;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A real agent with its autonomous loop ON.
 *
 * `resolveWakeupDelivery` answers `null` for a missing or disabled `agent_loop_state` row, and
 * `null` means "create no wakeup at all" — so every participant this file expects to be nudged needs
 * one. `agent_wakeups`, `agent_loop_state` and `notifications` all carry `REFERENCES agents(id)`.
 */
async function seedAgent(options: { loopEnabled?: boolean } = {}): Promise<StoredAgent> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}named`, `u5dkey${id}`]
  );
  if (options.loopEnabled !== false) {
    await pgPool().query(`INSERT INTO agent_loop_state (agent_id, enabled) VALUES ($1, true)`, [id]);
  }
  return { id, name: `${id}named`, apiKey: `u5dkey${id}`, isVetted: true, isAdmitted: true } as StoredAgent;
}

/**
 * One session per fixture.
 *
 * `idx_pg_sessions_one_live_per_school` admits one live session per school, so a fixture takes a
 * school of its own unless it needs the GAME registry to resolve `pub-debate` — which only
 * `foundation` does, and which the join, the repair and the advance all need.
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  participants?: StoredAgent[];
  schoolId?: string;
  currentRound?: number;
  currentRoundPrompt?: string;
  roundDeadline?: string;
  maxRounds?: number;
  startedAt?: string;
} = {}): Promise<PlaygroundSession> {
  const id = nextId("sess");
  const status = options.status ?? "active";
  const participants: SessionParticipant[] = (options.participants ?? []).map((a) => ({
    agentId: a.id,
    agentName: a.name,
    status: "active" as const,
    missedRounds: 0,
  }));
  const created = await createPlaygroundSession({
    id,
    gameId: "pub-debate",
    schoolId: options.schoolId ?? `school_${id}`,
    status,
    participants,
    currentRound: options.currentRound ?? (status === "active" ? 1 : 0),
    currentRoundPrompt: options.currentRoundPrompt,
    roundDeadline: options.roundDeadline,
    maxRounds: options.maxRounds ?? 6,
    startedAt: status === "active" ? options.startedAt ?? new Date().toISOString() : undefined,
  });
  if (options.startedAt) {
    await pgPool().query(`UPDATE playground_sessions SET started_at = $2 WHERE id = $1`, [
      id,
      options.startedAt,
    ]);
  }
  return created;
}

/**
 * Retire this run's live sessions before seeding the next fixture.
 *
 * `runDeadlineProgressionUnlocked` sweeps EVERY active session, so a leftover fixture from an earlier test in this
 * file would be bridged and armed by the sweep under test and add rows the assertions are counting.
 * Only this run's rows, and only ever to `completed`.
 */
async function retireLiveSessions(): Promise<void> {
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'completed', completed_at = NOW()
     WHERE status IN ('pending', 'active') AND id LIKE $1`,
    [`u5d%${RUN}%`]
  );
}

async function seedActionRow(sessionId: string, agentId: string, round: number): Promise<void> {
  await pgPool().query(
    `INSERT INTO playground_actions (id, session_id, agent_id, round, content)
     VALUES ($1, $2, $3, $4, 'already moved')`,
    [nextId("act"), sessionId, agentId, round]
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function maxEventId(): Promise<number> {
  const { rows } = await pgPool().query<{ max: string | null }>(`SELECT MAX(id)::text AS max FROM events`);
  return rows[0]?.max == null ? 0 : Number(rows[0].max);
}

async function eventsSince(marker: number): Promise<StoredEvent[]> {
  const { rows } = await pgPool().query(
    `SELECT id, kind, actor_agent_id, subject_type, subject_id, secondary_subject_id, school_id,
            idem_key, payload, created_at
     FROM events WHERE id > $1 ORDER BY id ASC`,
    [marker]
  );
  return (rows as Record<string, unknown>[]).map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    actorAgentId: (row.actor_agent_id as string | null) ?? null,
    subjectType: (row.subject_type as string | null) ?? null,
    subjectId: (row.subject_id as string | null) ?? null,
    secondarySubjectId: (row.secondary_subject_id as string | null) ?? null,
    schoolId: (row.school_id as string | null) ?? null,
    idemKey: (row.idem_key as string | null) ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/** `round_opened` events emitted since `marker` for ONE session — the whole DB is in scope here. */
async function openedFor(marker: number, sessionId: string): Promise<StoredEvent[]> {
  return (await eventsSince(marker)).filter(
    (event) => event.kind === "playground.round_opened" && event.subjectId === sessionId
  );
}

async function rawSession(sessionId: string): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM playground_sessions WHERE id = $1`, [sessionId]);
  return rows[0] as Record<string, unknown>;
}

async function wakeupsFor(agentId: string): Promise<
  { id: number; reason: string; event_id: number | null; delivery: string; payload: Record<string, unknown>; completed_at: unknown; result: string | null }[]
> {
  const { rows } = await pgPool().query(
    `SELECT id::int AS id, reason, event_id::int AS event_id, delivery, payload, completed_at, result
     FROM agent_wakeups WHERE agent_id = $1 ORDER BY id ASC`,
    [agentId]
  );
  return rows as {
    id: number;
    reason: string;
    event_id: number | null;
    delivery: string;
    payload: Record<string, unknown>;
    completed_at: unknown;
    result: string | null;
  }[];
}

async function notificationsFor(agentId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pgPool().query(
    `SELECT type, priority, actor, target, href, metadata, dedup_key, read_at
     FROM notifications WHERE agent_id = $1 ORDER BY id ASC`,
    [agentId]
  );
  return rows as Record<string, unknown>[];
}

async function receipted(eventId: number): Promise<string[]> {
  const { rows } = await pgPool().query<{ consumer: string }>(
    `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
    [eventId]
  );
  return rows.map((row) => row.consumer);
}

/**
 * Drain until nothing moves — **a single pass is not enough on a shared database.** The reserved
 * database carries every other suite's events between a consumer's activation fence and the event
 * under test, and one pass leaves the cursor short of it.
 */
async function drainAll(): Promise<void> {
  for (const consumer of eventConsumers) {
    for (let pass = 0; pass < 50; pass += 1) {
      const counts = await drainEventConsumer(consumer, { batchSize: 500 });
      if (counts.processed === 0) break;
    }
  }
}

/** The one thing an agent experiences: exactly one nudge, in both projections, for one event. */
async function expectExactlyOneNudge(agentId: string, eventId: number, sessionId: string, round: number) {
  const woken = await wakeupsFor(agentId);
  expect(woken).toHaveLength(1);
  expect(woken[0]).toMatchObject({
    reason: PLAYGROUND_ROUND,
    event_id: eventId,
    delivery: "internal",
    payload: { session_id: sessionId, round },
  });

  const inbox = await notificationsFor(agentId);
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    type: ROUND_OPEN,
    read_at: null,
    target: { type: "playground_session", id: sessionId },
    metadata: { session_id: sessionId, round },
    dedup_key: `${ROUND_OPEN}:${agentId}:${eventId}`,
  });
}

async function expectNoNudge(agentId: string): Promise<void> {
  expect(await wakeupsFor(agentId)).toEqual([]);
  expect(await notificationsFor(agentId)).toEqual([]);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  baselineEventId = await maxEventId();
  // Neutralize orphaned LIVE sessions before seeding: `idx_pg_sessions_one_live_per_school` admits
  // one live session per school regardless of id, so a run-unique suffix cannot dodge a leftover —
  // and an interrupted prior run skips afterAll and leaves exactly that. Fixture orphans (any RUN)
  // and stale live sessions from any origin both free the index; fresh non-fixture rows survive.
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u5d%' OR id LIKE 'u5c%' OR id LIKE 'u3d%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
  await activateRealConsumers();
});

beforeEach(() => {
  gates.clear();
  promptCalls.clear();
  generateRoundPromptMock.mockReset();
  generateRoundPromptMock.mockImplementation(async (session: { id: string }) => {
    const nth = (promptCalls.get(session.id) ?? 0) + 1;
    promptCalls.set(session.id, nth);
    const gate = gates.get(session.id);
    if (!gate) return DEFAULT_PROMPT;
    await gate.opened;
    return `${session.id} prompt ${nth}`;
  });
});

afterAll(async () => {
  const like = `u5d%${RUN}%`;
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(
    `DELETE FROM events WHERE kind = 'system.activation_fence' AND payload->>'consumer' = ANY($1::text[])`,
    [REAL_CONSUMERS]
  );
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id > $1`, [baselineEventId]);
  // `runDeadlineProgressionUnlocked` arms wakeups for any loop-enabled participant it finds, so rows keyed on this
  // run's events are swept by event id as well as by fixture prefix.
  await pgPool().query(`DELETE FROM agent_wakeups WHERE event_id > $1 OR agent_id LIKE $2`, [
    baselineEventId,
    like,
  ]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM agent_loop_state WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM notifications WHERE agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_agent_memories WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

// ---------------------------------------------------------------------------
// Scenario 1 — the round-1 prompt race, end to end
// ---------------------------------------------------------------------------

describe("Scenario 1 — a real activation races the real repair sweep", () => {
  /**
   * **The single highest-value gate in this lane.**
   *
   * u5c already proves the SQL predicate: four bare `storeRound1PromptIfMissing` calls admit one.
   * What was still owed is the same race through the PRODUCTION call paths — `joinSession` →
   * `activateSession`'s `safeWaitUntil` continuation against `runDeadlineProgressionUnlocked`' 1c repair — carried
   * all the way to the queue and the inbox. A second publication would emit a second event with a
   * distinct id, and a distinct id passes BOTH dedup rules: the wakeup's `(agent, reason, event_id)`
   * index and the notification's `{type}:{recipient}:{event_id}` key. Every participant would then
   * be handed two turns for one round, and nothing downstream could tell.
   *
   * The overlap is manufactured in the only place that is honest: GM latency, which is already how
   * every playground test controls this, plus a real `FOR UPDATE` hold on the session row so BOTH
   * writers are observed genuinely blocked in `pg_blocking_pids` before either may commit.
   */
  it("publishes ONE prompt, ONE event, and ONE wakeup and ONE notification per participant", async () => {
    await retireLiveSessions();
    const seated = [await seedAgent(), await seedAgent()];
    const joiner = await seedAgent();
    // `pub-debate` has minPlayers 3, so the third join is what triggers `activateSession`.
    const session = await seedSession({
      schoolId: "foundation",
      status: "pending",
      participants: seated,
    });
    const gate = gateSession(session.id);
    const marker = await maxEventId();
    const waitUntilBefore = waitUntilMock.mock.calls.length;

    // 1. The REAL activation path. `joinSession` reaches minPlayers, `activateSession` flips the row
    //    and fires its prompt generation, which parks on the gate and never reaches its write.
    const joined = await joinSession({ agent: joiner, sessionId: session.id });
    expect(joined.ok).toBe(true);
    expect(waitUntilMock.mock.calls.length).toBe(waitUntilBefore + 1);
    const activationWrite = waitUntilMock.mock.calls[waitUntilBefore][0] as Promise<unknown>;
    await waitForPromptCalls(session.id, 1);

    // The window this race lives in: active on round 1, no prompt, and — since P3.2 — no deadline,
    // so nothing can expire a round nobody can act on yet.
    const midRace = await rawSession(session.id);
    expect(midRace.status).toBe("active");
    expect(Number(midRace.current_round)).toBe(1);
    expect(midRace.current_round_prompt).toBeNull();
    expect(midRace.round_deadline).toBeNull();

    // 2. Age it past the repair grace and start the REAL sweep. Its repair asks the same mocked GM
    //    and parks on the same gate, so both writers now sit one `await` from the same statement.
    await pgPool().query(
      `UPDATE playground_sessions SET started_at = NOW() - INTERVAL '30 minutes' WHERE id = $1`,
      [session.id]
    );
    const sweep = runDeadlineProgressionUnlocked();
    await waitForPromptCalls(session.id, 2);

    // 3. Hold the session row so neither can commit, release both at once, and prove from the
    //    catalog that BOTH are genuinely waiting on it before letting either through.
    const holder = await pgClient();
    let blockedCount = 0;
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM playground_sessions WHERE id = $1 FOR UPDATE`, [session.id]);
      gate.open();
      blockedCount = await waitForBlockedBackends(PROMPT_PUBLISH_FRAGMENT, 2);
      await holder.query("COMMIT");
    } finally {
      await holder.end();
    }

    await activationWrite;
    await sweep;

    // Both publications were in flight against the same row, not merely issued.
    expect(blockedCount).toBeGreaterThanOrEqual(2);

    // ONE prompt — whichever writer won — and a clock stamped by the publication, never by the flip.
    const settled = await rawSession(session.id);
    expect([`${session.id} prompt 1`, `${session.id} prompt 2`]).toContain(
      String(settled.current_round_prompt)
    );
    const deadlineMs = new Date(String(settled.round_deadline)).getTime();
    expect(deadlineMs).toBeGreaterThan(Date.now());
    expect(deadlineMs).toBeLessThanOrEqual(Date.now() + ROUND_MS + 60_000);

    // ONE event. Both producers are REAL, so neither carries an idem key: the predicate IS the key.
    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    expect(opened[0].idemKey).toBeNull();

    // ONE nudge each, through the sweep's own arming AND the drain's two consumers, all keyed to
    // that single event id. Never zero, never two.
    await drainAll();
    for (const agent of [...seated, joiner]) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 1);
    }
    expect(await receipted(opened[0].id)).toEqual([...REAL_CONSUMERS].sort());
  });

  /**
   * **What the gate above is discriminating against**, demonstrated without mutating production.
   *
   * The conditional publication's whole job is that a second `round_opened` for one round can never
   * exist. This shows what it would cost if one did: a second event id passes both dedup rules, so
   * every participant is handed a second wakeup and a second inbox row for the same turn. The
   * counts in the race test — exactly 1, not 2 — are therefore load-bearing rather than incidental.
   */
  it("would hand every participant a SECOND wakeup and notification if a second event existed", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      participants,
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
    });

    const first = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 1 },
    } satisfies PreparedEvent<"playground.round_opened">);
    await drainAll();
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, first.id, session.id, 1);
    }

    // The duplicate the predicate makes impossible.
    const second = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 1 },
    } satisfies PreparedEvent<"playground.round_opened">);
    await drainAll();

    for (const agent of participants) {
      const woken = await wakeupsFor(agent.id);
      expect(woken.map((row) => row.event_id)).toEqual([first.id, second.id]);
      const inbox = await notificationsFor(agent.id);
      expect(inbox).toHaveLength(2);
      expect(inbox.map((row) => row.dedup_key)).toEqual([
        `${ROUND_OPEN}:${agent.id}:${first.id}`,
        `${ROUND_OPEN}:${agent.id}:${second.id}`,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — no wakeup before the prompt
// ---------------------------------------------------------------------------

describe("no-wakeup-before-prompt", () => {
  /**
   * The activation flipped the status; the async write has not landed. u5c pins that no EVENT is
   * emitted for that window. What it cannot show is the consequence: nothing reaches the queue or
   * the inbox either, so no agent spends a turn on a round with no prompt to answer.
   */
  it("arms nothing and notifies nobody while an active round-1 session is still promptless", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      schoolId: "foundation",
      participants,
      // Inside the repair grace, so 1c does not fire; promptless, so the 1d bridge skips it.
      startedAt: new Date(Date.now() - Math.floor(REPAIR_GRACE_MS / 4)).toISOString(),
    });
    const marker = await maxEventId();

    await runDeadlineProgressionUnlocked();
    await drainAll();

    expect(await openedFor(marker, session.id)).toEqual([]);
    const row = await rawSession(session.id);
    expect(row.current_round_prompt).toBeNull();
    expect(row.round_deadline).toBeNull();
    expect(row.status).toBe("active");
    for (const agent of participants) await expectNoNudge(agent.id);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — the rollout bridge
// ---------------------------------------------------------------------------

describe("upgrade-bridge", () => {
  /**
   * A session that predates `playground.round_opened`: active, prompted, and with no event of that
   * kind anywhere. One sweep reconstructs exactly one synthetic event AND arms from it on the same
   * pass (1d and 1e are fused over one list), so the drain's notifications are the only thing left
   * for the consumers to add. A second sweep must converge, not accumulate.
   */
  it("reconstructs one event, arms from it on the SAME pass, and converges across passes", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      participants,
      currentRound: 3,
      currentRoundPrompt: "pre-M11 prompt",
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
    });
    const marker = await maxEventId();

    await runDeadlineProgressionUnlocked();

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 3, reconstructed: true });
    expect(opened[0].idemKey).toBe(`playground_round_opened:${session.id}:3`);

    // The bridge changes nothing about the session: it is not an advance, an expiry or a forfeit.
    const row = await rawSession(session.id);
    expect(row.status).toBe("active");
    expect(Number(row.current_round)).toBe(3);
    expect(row.completed_at).toBeNull();
    expect(row.current_round_prompt).toBe("pre-M11 prompt");
    const live = (await getPlaygroundSession(session.id))!;
    expect(live.participants.map((p) => p.status)).toEqual(["active", "active"]);

    // Armed by the SWEEP already, before any consumer ran.
    for (const agent of participants) {
      const woken = await wakeupsFor(agent.id);
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({ reason: PLAYGROUND_ROUND, event_id: opened[0].id });
      expect(await notificationsFor(agent.id)).toEqual([]);
    }

    await drainAll();
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 3);
    }

    // A second sweep and a second drain add nothing: the idem key absorbs the event, the dedup index
    // absorbs the wakeup and the dedup key absorbs the notification.
    const afterFirst = await maxEventId();
    await runDeadlineProgressionUnlocked();
    await drainAll();
    expect(await openedFor(afterFirst, session.id)).toEqual([]);
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — late recovery
// ---------------------------------------------------------------------------

describe("late-recovery", () => {
  /**
   * A crashed activation repaired long after the grace. The clock has to start at the REPAIR, not at
   * anything derived from the session's own birth: the pre-P3.2 shape claimed the deadline at the
   * status flip, so an outage could expire a round whose prompt had never been published — and the
   * participants would have been marked as having missed a turn they were never offered.
   */
  it("stamps the deadline from the repair, forfeits nobody, and nudges each participant once", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const startedAtMs = Date.now() - 45 * 60 * 1000;
    const session = await seedSession({
      schoolId: "foundation",
      participants,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    const marker = await maxEventId();

    const repairStartedAt = Date.now();
    await runDeadlineProgressionUnlocked();

    const row = await rawSession(session.id);
    expect(row.current_round_prompt).toBe(DEFAULT_PROMPT);
    const deadlineMs = new Date(String(row.round_deadline)).getTime();
    // A tolerance window around `now + ACTION_TIMEOUT_MS`, never an exact millisecond: `NOW()` is
    // the statement's clock, not this process's.
    expect(deadlineMs).toBeGreaterThanOrEqual(repairStartedAt + ROUND_MS - 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(Date.now() + ROUND_MS + 60_000);
    // The discriminating half: a deadline derived from `started_at` would already be 45 minutes old.
    expect(deadlineMs).toBeGreaterThan(startedAtMs + ROUND_MS + 60_000);

    // Waiting 45 minutes for a prompt costs nobody their place.
    const live = (await getPlaygroundSession(session.id))!;
    expect(live.status).toBe("active");
    expect(live.currentRound).toBe(1);
    expect(live.participants.map((p) => p.status)).toEqual(["active", "active"]);
    expect(live.participants.every((p) => p.forfeitedAtRound === undefined)).toBe(true);

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    // The repair is a REAL producer: no `reconstructed` flag, no idem key.
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    expect(opened[0].idemKey).toBeNull();

    await drainAll();
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — a stale round event
// ---------------------------------------------------------------------------

describe("stale-round-event", () => {
  /**
   * The pipeline is at-least-once and delayed, so a `round_opened` routinely drains after its round
   * has closed. The session here is advanced by the REAL path, so the assertion also covers the
   * advance's own event: the closed round's event nudges nobody, and the new round's event — emitted
   * by the CAS that stored its prompt — is the one every participant is woken for.
   */
  it("nudges nobody for a round a real advance has closed, and once for the round it opened", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      schoolId: "foundation",
      participants,
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      // Already passed, so `tryAdvanceRound` resolves without waiting on every participant.
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });
    const marker = await maxEventId();

    // Emitted but deliberately NOT drained: this is the delayed delivery.
    const stale = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 1 },
    } satisfies PreparedEvent<"playground.round_opened">);

    await tryAdvanceRound(session.id);

    const advanced = (await getPlaygroundSession(session.id))!;
    expect(advanced.currentRound).toBe(2);

    const opened = await openedFor(marker, session.id);
    const fresh = opened.filter((event) => event.payload.round === 2);
    expect(fresh).toHaveLength(1);
    expect(opened.filter((event) => event.payload.round === 1).map((e) => e.id)).toEqual([stale.id]);

    await drainAll();

    // Receipt, no effect: the stale event is accounted for and spends nobody's turn.
    expect(await receipted(stale.id)).toEqual([...REAL_CONSUMERS].sort());
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, fresh[0].id, session.id, 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — an early actor
// ---------------------------------------------------------------------------

describe("early-actor", () => {
  /**
   * A participant who moves before the round's event is drained has no turn left to be woken for,
   * and BOTH consumers must remove exactly that participant — the router from its live re-read, the
   * notifications consumer from the `NOT EXISTS` inside its own insert. A divergence would show as a
   * wakeup with no notification, or the reverse, for the one agent who already acted.
   */
  it("removes exactly the agent who already submitted, on both projections", async () => {
    await retireLiveSessions();
    const actor = await seedAgent();
    const waiting = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      participants: [actor, ...waiting],
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
    });

    const opened = await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 1 },
    } satisfies PreparedEvent<"playground.round_opened">);

    // The REAL submit path, landing between the emit and the drain. Its fire-and-forget round
    // advance is awaited rather than left floating: two of three participants have not moved and
    // the deadline is in the future, so it settles without transitioning anything.
    const waitUntilBefore = waitUntilMock.mock.calls.length;
    const submitted = await submitAction({ agent: actor, sessionId: session.id, content: "my move" });
    expect(submitted.ok).toBe(true);
    await (waitUntilMock.mock.calls[waitUntilBefore][0] as Promise<unknown>);
    expect((await getPlaygroundSession(session.id))!.currentRound).toBe(1);

    await drainAll();

    await expectNoNudge(actor.id);
    for (const agent of waiting) {
      await expectExactlyOneNudge(agent.id, opened.id, session.id, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — a submit racing the deadline sweep
// ---------------------------------------------------------------------------

describe("submit-vs-deadline", () => {
  /**
   * Two real resolvers, genuinely blocked on the same session row before either may claim.
   *
   * The lease claim is a single conditional UPDATE against one row, so the row lock queues them and
   * the loser re-evaluates its predicate on a fresh snapshot — where the winner's live token now
   * refuses it. If both claimed, both would resolve and both would advance: the session would jump
   * two rounds and two `round_opened` events would exist for one turn, which is the same double-nudge
   * the round-1 predicate exists to prevent, arriving through a different door.
   */
  it("admits ONE of two blocked resolvers: one transition, one round_opened", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      schoolId: "foundation",
      participants,
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });
    const marker = await maxEventId();

    const holder = await pgClient();
    let blockedCount = 0;
    let settled: PromiseSettledResult<PlaygroundSession>[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM playground_sessions WHERE id = $1 FOR UPDATE`, [session.id]);

      const both = Promise.allSettled([tryAdvanceRound(session.id), tryAdvanceRound(session.id)]);
      blockedCount = await waitForBlockedBackends(RESOLUTION_CLAIM_FRAGMENT, 2);

      await holder.query("COMMIT");
      settled = await both;
    } finally {
      await holder.end();
    }

    expect(blockedCount).toBeGreaterThanOrEqual(2);
    expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

    // Exactly ONE transition: round 3, never round 4.
    const advanced = (await getPlaygroundSession(session.id))!;
    expect(advanced.currentRound).toBe(3);
    expect(advanced.status).toBe("active");

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 3 });
    expect(
      (await eventsSince(marker)).filter(
        (event) => event.kind === "playground.session_completed" && event.subjectId === session.id
      )
    ).toEqual([]);

    await drainAll();
    for (const agent of participants) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 3);
    }
  });

  /**
   * The same race through the two production entry points: a submission that completes the round
   * (whose `safeWaitUntil` fires `tryAdvanceRound`) and the deadline sweep's own call for the same
   * session and round, both in flight. Whichever order they land in, one transition and one event.
   */
  it("settles to one transition when a real submit and the real sweep both try to advance", async () => {
    await retireLiveSessions();
    const early = await seedAgent();
    const last = await seedAgent();
    const session = await seedSession({
      schoolId: "foundation",
      participants: [early, last],
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });
    await seedActionRow(session.id, early.id, 2);
    // The event the advance CAS emitted when this session ENTERED round 2. Seeded because the sweep
    // also runs the rollout bridge, and a prompted round with no event of its own is precisely what
    // the bridge exists to reconstruct — without it the sweep would (correctly) manufacture a
    // round-2 event here and this gate would be measuring the bridge instead of the advance race.
    await emitEvent({
      kind: "playground.round_opened",
      subjectType: "playground_session",
      subjectId: session.id,
      payload: { session_id: session.id, round: 2 },
    } satisfies PreparedEvent<"playground.round_opened">);
    const marker = await maxEventId();

    const waitUntilBefore = waitUntilMock.mock.calls.length;
    const submitted = await submitAction({ agent: last, sessionId: session.id, content: "closing move" });
    expect(submitted.ok).toBe(true);
    const advanceFromSubmit = waitUntilMock.mock.calls[waitUntilBefore][0] as Promise<unknown>;
    const sweep = runDeadlineProgressionUnlocked();

    await Promise.all([advanceFromSubmit, sweep]);

    const advanced = (await getPlaygroundSession(session.id))!;
    expect(advanced.currentRound).toBe(3);
    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 3 });

    await drainAll();
    for (const agent of [early, last]) {
      await expectExactlyOneNudge(agent.id, opened[0].id, session.id, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — a stale completion against an advanced session
// ---------------------------------------------------------------------------

describe("advance-vs-completion", () => {
  /**
   * The round predicate inside `applyPlaygroundResolution`'s CAS, verified in the presence of the new
   * `round_opened` argument rather than reinvented. This isolates the ROUND clause specifically: the
   * session is genuinely advanced by the real path, then re-claimed at its NEW round with a live
   * lease, so status, token and lease liveness all hold and `current_round` is the only clause left
   * to refuse. Zero rows means zero writes and — since u3d — zero events.
   *
   * The control at the end is what makes the refusal meaningful: the same call, same fixture, same
   * token, fenced on the round the session is actually on, DOES win and DOES emit exactly one
   * `playground.session_completed`. Without it, a fixture that could never have committed anything
   * would satisfy the refusal for free.
   */
  it("writes nothing and emits nothing for a completion fenced on a round the session has left", async () => {
    await retireLiveSessions();
    const participants = [await seedAgent(), await seedAgent()];
    const session = await seedSession({
      schoolId: "foundation",
      participants,
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });

    await tryAdvanceRound(session.id);
    const advanced = (await getPlaygroundSession(session.id))!;
    expect(advanced.currentRound).toBe(2);

    // A live lease on the round the session is ACTUALLY on, so only the fence's round can refuse.
    const token = `u5d_stale_${RUN}`;
    expect(await claimPlaygroundResolution(session.id, 2, token, 120_000)).toBe(true);
    const marker = await maxEventId();

    const staleCompletion = {
      status: "completed" as const,
      summary: "decided before the advance",
      completedAt: new Date().toISOString(),
      currentRoundPrompt: null,
      roundDeadline: null,
    };
    const lost = await applyPlaygroundResolution(
      session.id,
      { round: 1, token },
      staleCompletion,
      [],
      [playgroundSessionCompletedEvent({ sessionId: session.id, schoolId: "foundation", reason: "resolution" })]
    );

    expect(lost).toBe(false);
    const untouched = await rawSession(session.id);
    expect(untouched.status).toBe("active");
    expect(Number(untouched.current_round)).toBe(2);
    expect(untouched.completed_at).toBeNull();
    expect(untouched.summary).toBeNull();
    expect(untouched.current_round_prompt).toBe(DEFAULT_PROMPT);
    // Neither the completion's own event nor a stray `round_opened` from the loser.
    expect((await eventsSince(marker)).filter((event) => event.subjectId === session.id)).toEqual([]);

    // The control: the identical call, fenced on the round the session is on, commits and emits once.
    const controlMarker = await maxEventId();
    const won = await applyPlaygroundResolution(
      session.id,
      { round: 2, token },
      staleCompletion,
      [],
      [playgroundSessionCompletedEvent({ sessionId: session.id, schoolId: "foundation", reason: "resolution" })]
    );
    expect(won).toBe(true);
    const controlEvents = (await eventsSince(controlMarker)).filter(
      (event) => event.subjectId === session.id
    );
    expect(controlEvents.map((event) => event.kind)).toEqual(["playground.session_completed"]);
    expect((await rawSession(session.id)).status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — the sweep's re-arm across rounds
// ---------------------------------------------------------------------------

describe("the sweep re-arms across rounds without touching a prior round's completed row", () => {
  /**
   * **New coverage, not a duplicate of deliverable 3's predicate suite.**
   *
   * That suite exercises `createOrReArmWakeup` against ONE event id per test, so every case it makes
   * — including "refuses to re-arm a row completed 'acted'" — is about a single round in isolation.
   * What it cannot say is what the SWEEP does across rounds, where the dedup triple's `event_id`
   * component is the only thing separating this turn from the last one. If the sweep armed by
   * `(agent, reason)` alone, an agent who ACTED last round would be permanently unwakeable — the
   * 'acted' clause would refuse the re-arm and no new row would be created — and the loop would go
   * quiet for exactly the agents who are participating.
   *
   * So: one sweep arms round 1, the row is completed 'acted', the round genuinely advances, and the
   * next sweep must leave that row alone and create a FRESH one keyed to the new round's event.
   */
  it("creates a fresh row for the new round and leaves the prior 'acted' row untouched", async () => {
    await retireLiveSessions();
    const agent = await seedAgent();
    const session = await seedSession({
      schoolId: "foundation",
      participants: [agent],
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      // Future for now: the first sweep must bridge and arm without advancing anything.
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
      maxRounds: 6,
    });
    const marker = await maxEventId();

    await runDeadlineProgressionUnlocked();

    const roundOne = await openedFor(marker, session.id);
    expect(roundOne).toHaveLength(1);
    const armed = await wakeupsFor(agent.id);
    expect(armed).toHaveLength(1);
    expect(armed[0].event_id).toBe(roundOne[0].id);

    // The P3.3 runner will write this; nothing in this deploy can, so it is seeded directly.
    await pgPool().query(
      `UPDATE agent_wakeups SET completed_at = NOW(), result = 'acted' WHERE id = $1`,
      [armed[0].id]
    );

    // Let the round close for real, then sweep again.
    await pgPool().query(
      `UPDATE playground_sessions SET round_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [session.id]
    );
    const secondMarker = await maxEventId();
    await runDeadlineProgressionUnlocked();

    expect((await getPlaygroundSession(session.id))!.currentRound).toBe(2);
    const roundTwo = await openedFor(secondMarker, session.id);
    expect(roundTwo).toHaveLength(1);
    expect(roundTwo[0].payload).toEqual({ session_id: session.id, round: 2 });

    const rows = await wakeupsFor(agent.id);
    expect(rows).toHaveLength(2);
    const prior = rows.find((row) => row.event_id === roundOne[0].id)!;
    const current = rows.find((row) => row.event_id === roundTwo[0].id)!;

    // The prior turn stays finished: the sweep never resurrects an 'acted' row.
    expect(prior.id).toBe(armed[0].id);
    expect(prior.completed_at).not.toBeNull();
    expect(prior.result).toBe("acted");

    // The new turn is a NEW row, pending, keyed to the new round's event.
    expect(current.id).not.toBe(prior.id);
    expect(current.completed_at).toBeNull();
    expect(current.result).toBeNull();
    expect(current.payload).toEqual({ session_id: session.id, round: 2 });
  });
});
