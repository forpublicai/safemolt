/**
 * M11-2 u5 lane C (P3.2) `[integration]` — the `playground.round_opened` PRODUCERS against a real
 * Postgres.
 *
 * The memory-mode suite proves the branch decisions and the shape test proves the rendered SQL; only
 * this one can prove the new statement PARSES and that its guarantee holds under real contention.
 * Every gate below is a property of a statement, not of a code path:
 *
 *  - **activation no longer claims a deadline**, so an outage cannot expire a round nobody could
 *    ever act on — `round_deadline` is left NULL by the status flip and stamped by the publication;
 *  - the **round-1 prompt write is conditional**, so two writers racing (a slow activation
 *    continuation against the sweep's repair) store ONE prompt and emit ONE event — the loser's
 *    `current_round_prompt IS NULL` predicate no longer holds, and its event insert reads zero rows;
 *  - the **repair query is due-state driven and oldest-first**, so a stuck session cannot hide
 *    behind newer ones;
 *  - **rounds >= 2 open through the resolution CAS**, which already gates the event on the same
 *    `advanced` CTE that carries the prompt — so an advance emits exactly one event naming the NEW
 *    round;
 *  - the **rollout bridge** gives an active, prompted round that predates this kind exactly one
 *    synthetic event, and a second sweep adds none.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "next round prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

// Embedding is an outbound HTTP call the resolution path makes per participant. It degrades rather
// than fails, but a real attempt would make this suite depend on a token and on latency.
jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

import { playgroundRoundOpenedEvent } from "@/lib/actions/playground-events";
import { checkDeadlines, tryAdvanceRound } from "@/lib/playground/session-manager";
import {
  activatePlaygroundSession,
  createPlaygroundSession,
  getPlaygroundSession,
  listSessionsNeedingRound1PromptRepair,
  storeRound1PromptIfMissing,
} from "@/lib/store/playground/db";
import type { PlaygroundSession, SessionParticipant } from "@/lib/playground/types";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u5c${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

const ROUND_MS = 60 * 60 * 1000;

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}named`, `u5ckey${id}`]
  );
  return { id, name: `${id}named`, apiKey: `u5ckey${id}`, isVetted: true, isAdmitted: true } as StoredAgent;
}

/**
 * One session per fixture, in its OWN school by default.
 *
 * `idx_pg_sessions_one_live_per_school` (M11-1 C23) admits one live session per school and these
 * fixtures deliberately hold several at once. A fixture that needs the GAME registry to resolve
 * `pub-debate` (the advance path does) names `foundation` and retires the previous live one.
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

/** Free a real school's live-session slot; only this suite's own rows, and only to `completed`. */
async function retireLiveSessions(schoolId: string): Promise<void> {
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'completed', completed_at = NOW()
     WHERE school_id = $1 AND status IN ('pending', 'active') AND id LIKE $2`,
    [schoolId, `u5c%${RUN}%`]
  );
}

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
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/** `round_opened` events emitted since `marker` for ONE session — the whole DB is in scope here. */
async function openedFor(marker: number, sessionId: string): Promise<StoredEvent[]> {
  return (await eventsSince(marker)).filter(
    (event) => event.kind === "playground.round_opened" && event.subjectId === sessionId
  );
}

async function trailRowExists(sessionId: string): Promise<boolean> {
  const { rowCount } = await pgPool().query(
    `SELECT 1 FROM activity_events WHERE kind = 'playground_session' AND entity_id = $1`,
    [sessionId]
  );
  return (rowCount ?? 0) > 0;
}

async function rawSession(sessionId: string): Promise<Record<string, unknown>> {
  const { rows } = await pgPool().query(`SELECT * FROM playground_sessions WHERE id = $1`, [sessionId]);
  return rows[0] as Record<string, unknown>;
}

beforeAll(async () => {
  baselineEventId = await maxEventId();
  // Neutralize orphaned LIVE sessions before seeding: `idx_pg_sessions_one_live_per_school` admits
  // one live session per school regardless of id, so a run-unique suffix cannot dodge a leftover —
  // and an interrupted prior run skips afterAll and leaves exactly that. Fixture orphans (any RUN)
  // and stale live sessions from any origin both free the index; fresh non-fixture rows survive.
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'cancelled', completed_at = NOW()
     WHERE status IN ('pending', 'active')
       AND (id LIKE 'u5c%' OR id LIKE 'u3d%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
});

afterAll(async () => {
  const like = `u5c%${RUN}%`;
  // `checkDeadlines` arms wakeups for any loop-enabled participant it finds, so rows keyed on this
  // run's events are swept by event id rather than by fixture prefix.
  await pgPool().query(`DELETE FROM agent_wakeups WHERE event_id > $1 OR agent_id LIKE $2`, [
    baselineEventId,
    like,
  ]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_agent_memories WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("activation stops pre-setting the deadline", () => {
  it("flips a pending session to active and leaves round_deadline NULL", async () => {
    const session = await seedSession({ status: "pending" });

    expect(await activatePlaygroundSession(session.id, 1, new Date().toISOString())).toBe(true);

    const row = await rawSession(session.id);
    expect(row.status).toBe("active");
    expect(Number(row.current_round)).toBe(1);
    expect(row.started_at).not.toBeNull();
    // The clock belongs to the PUBLICATION. An active round-1 session promptless in this window is
    // un-expirable, because every deadline-scanning path keys off `round_deadline` being set at all.
    expect(row.round_deadline).toBeNull();
    expect(row.current_round_prompt).toBeNull();
    // The session did become visibly active, so the trail still refreshes.
    expect(await trailRowExists(session.id)).toBe(true);
  });

  it("admits exactly one activator", async () => {
    const session = await seedSession({ status: "pending" });
    const now = new Date().toISOString();

    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, () => () => activatePlaygroundSession(session.id, 1, now))
    );
    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((o) => o.ok && o.value === true)).toHaveLength(1);
  });
});

describe("storeRound1PromptIfMissing — the conditional publication", () => {
  it("publishes the prompt, stamps the clock from NOW(), and emits one round_opened", async () => {
    const session = await seedSession({ status: "pending" });
    await activatePlaygroundSession(session.id, 1, new Date().toISOString());
    const marker = await maxEventId();

    const stored = await storeRound1PromptIfMissing(session.id, "round 1 prompt", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: session.schoolId ?? null }),
    ]);
    expect(stored).toBe(true);

    const row = await rawSession(session.id);
    expect(row.current_round_prompt).toBe("round 1 prompt");
    const deadline = new Date(String(row.round_deadline)).getTime();
    expect(deadline).toBeGreaterThan(Date.now());
    // Stamped from NOW() by the statement, so it measures the round from the instant a participant
    // could first act rather than from the status flip that preceded it.
    expect(deadline).toBeLessThanOrEqual(Date.now() + ROUND_MS + 60_000);

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    expect(opened[0].subjectType).toBe("playground_session");
    expect(opened[0].actorAgentId).toBeNull();
    // A REAL producer carries no idem key: the statement's predicate is its uniqueness.
    expect(opened[0].idemKey).toBeNull();
  });

  it("writes nothing and emits nothing once a prompt is already stored", async () => {
    const session = await seedSession({ status: "pending" });
    await activatePlaygroundSession(session.id, 1, new Date().toISOString());
    await storeRound1PromptIfMissing(session.id, "first prompt", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: null }),
    ]);
    const marker = await maxEventId();

    const second = await storeRound1PromptIfMissing(session.id, "second prompt", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: null }),
    ]);

    expect(second).toBe(false);
    expect((await rawSession(session.id)).current_round_prompt).toBe("first prompt");
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * **The round-1 prompt race.** A slow activation writer against the sweep's repair, both landing
   * at once. The predicate decides: exactly one prompt is stored, exactly one event exists. Routed
   * through `updatePlaygroundSession` — an unconditional COALESCE update — all four would have
   * "succeeded" and emitted, handing every participant four turns for one round.
   */
  it("admits ONE of four concurrent publications and emits exactly one event", async () => {
    const session = await seedSession({ status: "pending" });
    await activatePlaygroundSession(session.id, 1, new Date().toISOString());
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, (_, i) => () =>
        storeRound1PromptIfMissing(session.id, `prompt ${i}`, ROUND_MS, [
          playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: null }),
        ])
      )
    );

    expect(rejections(outcomes)).toEqual([]);
    expect(outcomes.filter((o) => o.ok && o.value === true)).toHaveLength(1);
    expect(await openedFor(marker, session.id)).toHaveLength(1);
  });

  it("refuses a session that is not active, or not on round 1", async () => {
    const pending = await seedSession({ status: "pending" });
    const laterRound = await seedSession({
      currentRound: 4,
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
    });
    const marker = await maxEventId();

    expect(await storeRound1PromptIfMissing(pending.id, "p", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: pending.id, round: 1, schoolId: null }),
    ])).toBe(false);
    expect(await storeRound1PromptIfMissing(laterRound.id, "p", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: laterRound.id, round: 1, schoolId: null }),
    ])).toBe(false);
    expect(await eventsSince(marker)).toEqual([]);
  });

  /**
   * `round_opened` has no activity-trail coverage: a round opening is not a public activity kind,
   * and the session's trail row carries lifecycle state only. So the publication writes no trail row
   * — and, for a session that already has one, does not move it.
   */
  it("writes no activity trail row of its own", async () => {
    const session = await seedSession({ status: "pending" });
    await activatePlaygroundSession(session.id, 1, new Date().toISOString());
    const { rows: before } = await pgPool().query<{ source_event_id: string | null }>(
      `SELECT source_event_id::text FROM activity_events WHERE kind = 'playground_session' AND entity_id = $1`,
      [session.id]
    );

    await storeRound1PromptIfMissing(session.id, "round 1 prompt", ROUND_MS, [
      playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: null }),
    ]);

    const { rows: after } = await pgPool().query<{ source_event_id: string | null }>(
      `SELECT source_event_id::text FROM activity_events WHERE kind = 'playground_session' AND entity_id = $1`,
      [session.id]
    );
    expect(after[0]?.source_event_id ?? null).toBe(before[0]?.source_event_id ?? null);
  });
});

describe("listSessionsNeedingRound1PromptRepair", () => {
  it("answers the aged, promptless, active round-1 sessions oldest first", async () => {
    const older = await seedSession({
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const newer = await seedSession({
      startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    // Excluded three ways: inside the grace, already prompted, and past round 1.
    const fresh = await seedSession({ startedAt: new Date().toISOString() });
    const prompted = await seedSession({
      currentRoundPrompt: "already prompted",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const round2 = await seedSession({
      currentRound: 2,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const stuck = await listSessionsNeedingRound1PromptRepair(2 * 60 * 1000, 200);
    const mine = stuck.map((s) => s.id).filter((id) => id.includes(RUN));

    expect(mine).toContain(older.id);
    expect(mine).toContain(newer.id);
    expect(mine).not.toContain(fresh.id);
    expect(mine).not.toContain(prompted.id);
    expect(mine).not.toContain(round2.id);
    // Oldest first, so a bounded page is a delay rather than starvation.
    expect(mine.indexOf(older.id)).toBeLessThan(mine.indexOf(newer.id));
  });
});

describe("rounds >= 2 open through the resolution CAS", () => {
  it("emits exactly one round_opened naming the NEW round, on the write that stores its prompt", async () => {
    await retireLiveSessions("foundation");
    const agent = await seedAgent();
    const session = await seedSession({
      schoolId: "foundation",
      participants: [agent],
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      // Already passed, so `tryAdvanceRound` resolves without waiting on every participant.
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });
    const marker = await maxEventId();

    await tryAdvanceRound(session.id);

    const advanced = (await getPlaygroundSession(session.id))!;
    expect(advanced.currentRound).toBe(2);
    expect(advanced.currentRoundPrompt).toBe("next round prompt");

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 2 });
    expect(opened[0].subjectType).toBe("playground_session");
    expect(opened[0].actorAgentId).toBeNull();
    // Completion is a different transition and keeps its own kind: an advance opens a round, it does
    // not end a session.
    expect(
      (await eventsSince(marker)).filter(
        (e) => e.kind === "playground.session_completed" && e.subjectId === session.id
      )
    ).toEqual([]);
  });

  it("emits nothing when the CAS loses its fence", async () => {
    await retireLiveSessions("foundation");
    const agent = await seedAgent();
    const session = await seedSession({
      schoolId: "foundation",
      participants: [agent],
      currentRound: 1,
      currentRoundPrompt: "round 1 prompt",
      roundDeadline: new Date(Date.now() - 60_000).toISOString(),
      maxRounds: 6,
    });
    // A live lease held by somebody else: this resolver's claim is refused, so it spends nothing and
    // never reaches the CAS. The event travels with the CAS, so nothing is emitted either.
    await pgPool().query(
      `UPDATE playground_sessions
       SET resolve_claim_token = 'someone_else', resolve_claim_expires_at = NOW() + INTERVAL '10 minutes'
       WHERE id = $1`,
      [session.id]
    );
    const marker = await maxEventId();

    await tryAdvanceRound(session.id);

    expect((await getPlaygroundSession(session.id))!.currentRound).toBe(1);
    expect(await openedFor(marker, session.id)).toEqual([]);
  });
});

describe("the rollout bridge", () => {
  it("reconstructs exactly one round_opened for a prompted round that predates the kind", async () => {
    const agent = await seedAgent();
    const session = await seedSession({
      participants: [agent],
      currentRound: 3,
      currentRoundPrompt: "pre-M11 prompt",
      roundDeadline: new Date(Date.now() + ROUND_MS).toISOString(),
    });
    const marker = await maxEventId();

    await checkDeadlines();

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({
      session_id: session.id,
      round: 3,
      reconstructed: true,
    });
    expect(opened[0].idemKey).toBe(`playground_round_opened:${session.id}:3`);

    // Repeated passes converge on exactly one event.
    const afterFirst = await maxEventId();
    await checkDeadlines();
    expect(await openedFor(afterFirst, session.id)).toEqual([]);
  });

  it("leaves a promptless round to the repair, emitting nothing for it", async () => {
    const agent = await seedAgent();
    const session = await seedSession({
      participants: [agent],
      // Inside the repair grace, so neither the bridge nor the repair touches it this pass.
      startedAt: new Date().toISOString(),
    });
    const marker = await maxEventId();

    await checkDeadlines();

    expect(await openedFor(marker, session.id)).toEqual([]);
    expect((await rawSession(session.id)).current_round_prompt).toBeNull();
  });

  /**
   * The repair sweep end to end: an active round-1 session whose activation continuation crashed is
   * republished with a FRESH deadline and exactly one event — never into an already-expired one.
   */
  it("repairs a crashed round-1 prompt past the grace, with one event and a fresh deadline", async () => {
    // Foundation, because the repair regenerates through the GAME registry and only a real school
    // resolves `pub-debate`; a fixture school would be skipped with no game found.
    await retireLiveSessions("foundation");
    const agent = await seedAgent();
    const session = await seedSession({
      schoolId: "foundation",
      participants: [agent],
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const marker = await maxEventId();

    await checkDeadlines();

    const row = await rawSession(session.id);
    expect(row.current_round_prompt).toBe("next round prompt");
    expect(new Date(String(row.round_deadline)).getTime()).toBeGreaterThan(Date.now());

    const opened = await openedFor(marker, session.id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    // The repair is a REAL producer: no `reconstructed` flag, no idem key.
    expect(opened[0].idemKey).toBeNull();
  });
});
