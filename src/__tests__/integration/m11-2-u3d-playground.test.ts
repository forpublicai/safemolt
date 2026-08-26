/**
 * M11-2 u3d (P1.4) `[integration]` — the playground slice against a real Postgres.
 *
 * The memory-mode suites prove the branch decisions and the shape test proves the rendered SQL;
 * only this one can prove the statements PARSE and that their guarantees hold under contention.
 * Every gate below is a property of a statement, not of a code path:
 *
 *  - the **join is one statement**, so a concurrent duplicate join leaves one participant entry,
 *    one event and one trail row — where the pre-u3d pair of whole-column read-modify-writes could
 *    erase a join that had already returned success;
 *  - a **join racing an affiliation refresh** loses neither: the append and the merge are two
 *    mutually exclusive branches of the same locked `UPDATE`;
 *  - the **duplicate-per-round action race** admits exactly one row and emits exactly one event,
 *    because the loser's `ON CONFLICT DO NOTHING` inserts nothing for the event to read;
 *  - a **nonparticipant's cancel** writes no tuple and emits no event, since the containment
 *    predicate IS the gate;
 *  - the **expiry sweep fans out**: N expired sessions produce N events, each naming its own
 *    subject, and each session's trail row is stamped by ITS OWN event;
 *  - the **lifetime cap is conditional**, so a second sweep completes nothing and emits nothing;
 *  - and the **shadow soak runs through the REAL drain** for the session and action kinds,
 *    comparing keys AND canonical payloads with `occurred_at` equal on both sides.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "round prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

import { cancelSession, joinSession, submitAction } from "@/lib/actions/playground";
import { playgroundSessionCreatedEvent } from "@/lib/actions/playground-events";
import { activityTrailEffects } from "@/lib/events/consumers/activity-trail";
import { eventConsumers } from "@/lib/events/consumers/registry";
import { enforceSessionLifetimeCap } from "@/lib/playground/lifecycle";
import { runDeadlineProgressionUnlocked } from "@/lib/playground/session-manager";
import { drainEventConsumer } from "@/lib/store/events/drain-db";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  joinPlaygroundSessionWithOutcome,
} from "@/lib/store/playground/db";
import type { PlaygroundSession, SessionParticipant } from "@/lib/playground/types";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

import { runConcurrently, rejections } from "./helpers/concurrency";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { activateRealConsumers } from "./helpers/activate-consumers";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const nextId = (kind: string) => `u3d${kind}${RUN}${(seq += 1)}`;
let baselineEventId = 0;

const REAL_CONSUMERS = eventConsumers.map((consumer) => consumer.name);

async function seedAgent(): Promise<StoredAgent> {
  const id = nextId("agent");
  await pgPool().query(
    `INSERT INTO agents (id, name, description, api_key, points, vote_points, evaluation_points,
                         legacy_unattributed_points, follower_count, is_claimed, created_at, is_vetted)
     VALUES ($1, $2, '', $3, 0, 0, 0, 0, 0, false, NOW(), true)`,
    [id, `${id}named`, `u3dkey${id}`]
  );
  return { id, name: `${id}named`, apiKey: `u3dkey${id}`, isVetted: true, isAdmitted: true } as StoredAgent;
}

/**
 * One session per fixture, in its OWN school.
 *
 * `idx_pg_sessions_one_live_per_school` (M11-1 C23) admits one live session per school, and these
 * fixtures deliberately hold many at once. The school is also what the action's gate reads, so the
 * fixture agents are seeded admitted.
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  participants?: StoredAgent[];
  /**
   * The school, and therefore which GAME registry resolves. Defaults to a school of its own so
   * many live sessions can coexist; a fixture that needs `joinSession` (which resolves the game for
   * `minPlayers`/`maxPlayers`) must name a real school and retire the previous live one.
   */
  schoolId?: string;
  createdAt?: string;
  startedAt?: string;
} = {}): Promise<PlaygroundSession> {
  const id = nextId("sess");
  const status = options.status ?? "pending";
  const participants: SessionParticipant[] = (options.participants ?? []).map((a) => ({
    agentId: a.id,
    agentName: a.name,
    status: "active" as const,
  }));
  const created = await createPlaygroundSession({
    id,
    gameId: "pub-debate",
    schoolId: options.schoolId ?? `school_${id}`,
    status,
    participants,
    currentRound: status === "active" ? 1 : 0,
    currentRoundPrompt: status === "active" ? "prompt" : undefined,
    roundDeadline: status === "active" ? new Date(Date.now() + 3_600_000).toISOString() : undefined,
    maxRounds: 6,
    startedAt: status === "active" ? options.startedAt ?? new Date().toISOString() : undefined,
  }, [
    // Seeded through the store rather than the action so the fixture controls status and school —
    // but WITH the event the real path emits, because half these gates are about that coupling.
    playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: options.schoolId ?? `school_${id}` }),
  ]);
  // Ageing is a fixture concern, not a store one: the sweeps read `created_at` / `started_at`.
  if (options.createdAt) {
    await pgPool().query(`UPDATE playground_sessions SET created_at = $2 WHERE id = $1`, [
      id,
      options.createdAt,
    ]);
  }
  if (options.startedAt) {
    await pgPool().query(`UPDATE playground_sessions SET started_at = $2 WHERE id = $1`, [
      id,
      options.startedAt,
    ]);
  }
  return created;
}

/**
 * Free a real school's live-session slot.
 *
 * `idx_pg_sessions_one_live_per_school` admits one live session per school, and the join gates need
 * a school whose GAME registry resolves `pub-debate` — which is `foundation` and nothing else. Only
 * this suite's own rows are retired, and only ever to `completed`.
 */
async function retireLiveSessions(schoolId: string): Promise<void> {
  await pgPool().query(
    `UPDATE playground_sessions SET status = 'completed', completed_at = NOW()
     WHERE school_id = $1 AND status IN ('pending', 'active') AND id LIKE $2`,
    [schoolId, `u3d%${RUN}%`]
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

/** The trail row, minus the watermark: `source_event_id` is ordering metadata, not content. */
async function readActivity(kind: string, entityId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pgPool().query(
    `SELECT kind, occurred_at, actor_id, actor_name, actor_canonical_name, entity_id, title, href,
            summary, context_hint, search_text, metadata
     FROM activity_events WHERE kind = $1 AND entity_id = $2`,
    [kind, entityId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  };
}

async function sourceEventId(kind: string, entityId: string): Promise<number | null> {
  const { rows } = await pgPool().query<{ source_event_id: string | null }>(
    `SELECT source_event_id::text FROM activity_events WHERE kind = $1 AND entity_id = $2`,
    [kind, entityId]
  );
  return rows[0]?.source_event_id == null ? null : Number(rows[0].source_event_id);
}

async function participantsOf(sessionId: string): Promise<SessionParticipant[]> {
  return (await getPlaygroundSession(sessionId))?.participants ?? [];
}

async function actionRows(sessionId: string): Promise<number> {
  const { rows } = await pgPool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM playground_actions WHERE session_id = $1`,
    [sessionId]
  );
  return Number(rows[0].c);
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
       AND (id LIKE 'u3d%' OR created_at < NOW() - INTERVAL '1 hour')`
  );
});

afterAll(async () => {
  const like = `u3d%${RUN}%`;
  await pgPool().query(`DELETE FROM event_receipts WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumer_failures WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_dead_letters WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  await pgPool().query(`DELETE FROM event_consumers WHERE consumer = ANY($1::text[])`, [REAL_CONSUMERS]);
  // The fences too, so the next run's activation is not silently refused by a leftover idem key.
  await pgPool().query(
    `DELETE FROM events WHERE kind = 'system.activation_fence' AND payload->>'consumer' = ANY($1::text[])`,
    [REAL_CONSUMERS]
  );
  await pgPool().query(`DELETE FROM event_consumer_shadow WHERE event_id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM events WHERE id > $1`, [baselineEventId]);
  await pgPool().query(`DELETE FROM activity_contexts WHERE activity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM activity_events WHERE actor_id LIKE $1 OR entity_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_agent_memories WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_actions WHERE session_id LIKE $1 OR agent_id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM playground_sessions WHERE id LIKE $1`, [like]);
  await pgPool().query(`DELETE FROM agents WHERE id LIKE $1`, [like]);
  await closeIntegrationConnections();
});

describe("createPlaygroundSession — the insert and its event, one statement", () => {
  it("emits one session_created and stamps the trail row from it", async () => {
    const marker = await maxEventId();
    const session = await seedSession();

    const emitted = (await eventsSince(marker)).filter((e) => e.kind === "playground.session_created");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].subjectId).toBe(session.id);
    expect(emitted[0].subjectType).toBe("playground_session");
    expect(await sourceEventId("playground_session", session.id)).toBe(emitted[0].id);
  });
});

/**
 * **The transitional projection commits WITH its event, or nothing does** (u3d fix round, finding 2).
 *
 * Every producer used to commit its mutation and its event and then call the best-effort trail
 * writer as a SECOND auto-committed statement whose failure is swallowed. A crash or an upsert error
 * in that gap left the event committed with no legacy projection at all — the drain then stamps
 * `legacy_missing`, and `shadow` records only diagnostics, so the public trail row is simply absent
 * and nothing ever writes it. That is the exact rule CLAUDE.md states: *a transitional projection
 * must be written by the statement that emitted its event.*
 *
 * The only way to prove the splice from outside is to make the PROJECTION fail and watch the
 * mutation and the event fail with it, so a trigger on `activity_events` refuses one fixture's rows.
 * Under the pre-fix ordering this test's session and event would both be on disk with the error
 * logged and discarded.
 */
describe("the projection, the mutation and the event are one commit", () => {
  const TRIGGER_FN = `u3d_fail_activity_${RUN}`;
  const FAIL_PREFIX = `u3dfail${RUN}`;

  async function withRefusedActivityInsert<T>(run: () => Promise<T>): Promise<T> {
    await pgPool().query(`
      CREATE OR REPLACE FUNCTION ${TRIGGER_FN}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.entity_id LIKE '${FAIL_PREFIX}%' THEN
          RAISE EXCEPTION 'u3d injected activity failure';
        END IF;
        RETURN NEW;
      END;
      $fn$;
    `);
    await pgPool().query(`
      CREATE TRIGGER ${TRIGGER_FN} BEFORE INSERT ON activity_events
      FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()
    `);
    try {
      return await run();
    } finally {
      await pgPool().query(`DROP TRIGGER IF EXISTS ${TRIGGER_FN} ON activity_events`);
      await pgPool().query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
    }
  }

  async function sessionRowExists(id: string): Promise<boolean> {
    const { rows } = await pgPool().query(`SELECT 1 FROM playground_sessions WHERE id = $1`, [id]);
    return rows.length > 0;
  }

  it("rolls the session AND its event back when the trail upsert refuses", async () => {
    const id = `${FAIL_PREFIX}sess${(seq += 1)}`;
    const marker = await maxEventId();

    await withRefusedActivityInsert(async () => {
      await expect(
        createPlaygroundSession(
          {
            id,
            gameId: "pub-debate",
            schoolId: `school_${id}`,
            status: "pending",
            participants: [],
            currentRound: 0,
            maxRounds: 6,
          },
          [playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: `school_${id}` })]
        )
      ).rejects.toThrow(/u3d injected activity failure/);
    });

    // Neither half survived: the projection is a CTE of the same statement, so its failure takes the
    // insert and the event insert down with it.
    expect(await sessionRowExists(id)).toBe(false);
    expect((await eventsSince(marker)).filter((e) => e.subjectId === id)).toEqual([]);
    expect(await readActivity("playground_session", id)).toBeNull();
  });

  it("commits all three once the projection is allowed again", async () => {
    // The control: the same call, same fixture shape, with nothing refusing it. Without this the
    // test above would also pass against a producer that simply never worked.
    const id = `${FAIL_PREFIX}ok${(seq += 1)}`;
    const marker = await maxEventId();

    await createPlaygroundSession(
      {
        id,
        gameId: "pub-debate",
        schoolId: `school_${id}`,
        status: "pending",
        participants: [],
        currentRound: 0,
        maxRounds: 6,
      },
      [playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: `school_${id}` })]
    );

    expect(await sessionRowExists(id)).toBe(true);
    const emitted = (await eventsSince(marker)).filter((e) => e.subjectId === id);
    expect(emitted).toHaveLength(1);
    expect(await sourceEventId("playground_session", id)).toBe(emitted[0].id);
  });
});

describe("joinSession — one statement, two mutually exclusive branches", () => {
  it("appends, emits one session_joined, and stamps the trail row", async () => {
    const joiner = await seedAgent();
    await retireLiveSessions("foundation");
    const session = await seedSession({ schoolId: "foundation" });
    const marker = await maxEventId();

    const result = await joinSession({ agent: joiner, sessionId: session.id });
    expect(result.ok).toBe(true);

    const emitted = (await eventsSince(marker)).filter((e) => e.kind.startsWith("playground."));
    expect(emitted.map((e) => e.kind)).toEqual(["playground.session_joined"]);
    expect(emitted[0].actorAgentId).toBe(joiner.id);
    expect(await participantsOf(session.id)).toHaveLength(1);
    expect(await sourceEventId("playground_session", session.id)).toBe(emitted[0].id);
  });

  it("admits ONE of four concurrent duplicate joins, with one event and one participant entry", async () => {
    const joiner = await seedAgent();
    const session = await seedSession();
    const marker = await maxEventId();

    const participant: SessionParticipant = {
      agentId: joiner.id,
      agentName: joiner.name,
      status: "active",
    };
    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, () => () =>
        joinPlaygroundSessionWithOutcome(session.id, participant, 6)
      )
    );
    // A 40P01 here would be a lock-order defect in the statement, and a 23505 a shape defect.
    expect(rejections(outcomes)).toEqual([]);

    // The array is serialized by the row lock: exactly one call appended.
    expect(await participantsOf(session.id)).toHaveLength(1);
    // No events: this call passes none. What it proves is the WRITE side of the race.
    expect((await eventsSince(marker)).filter((e) => e.kind.startsWith("playground."))).toEqual([]);
  });

  it("loses neither an append nor a concurrent affiliation refresh", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const session = await seedSession({ participants: [first] });

    const outcomes = await runConcurrently([
      // `second` appends; `first` refreshes its own affiliation fields. Two branches, one row.
      () =>
        joinPlaygroundSessionWithOutcome(
          session.id,
          { agentId: second.id, agentName: second.name, status: "active" },
          6
        ),
      () =>
        joinPlaygroundSessionWithOutcome(
          session.id,
          {
            agentId: first.id,
            agentName: first.name,
            status: "active",
            actingAsLabel: "Acme Robotics",
          } as SessionParticipant,
          6
        ),
    ]);
    expect(rejections(outcomes)).toEqual([]);

    const participants = await participantsOf(session.id);
    // The append survived the merge's whole-array rewrite, and the merge survived the append.
    expect(participants.map((p) => p.agentId).sort()).toEqual([first.id, second.id].sort());
    expect(participants.find((p) => p.agentId === first.id)?.actingAsLabel).toBe("Acme Robotics");
  });

  it("emits participant_affiliation_updated with the fields the STATEMENT diffed, and nothing on a repeat", async () => {
    const joiner = await seedAgent();
    await retireLiveSessions("foundation");
    const session = await seedSession({ schoolId: "foundation" });
    await joinSession({ agent: joiner, sessionId: session.id });
    const marker = await maxEventId();

    const outcome = await joinPlaygroundSessionWithOutcome(
      session.id,
      {
        agentId: joiner.id,
        agentName: joiner.name,
        status: "active",
        actingAsLabel: "Acme",
        actingAsDisplaySummary: "Acting for Acme",
      } as SessionParticipant,
      6,
      {
        affiliationUpdated: [
          {
            kind: "playground.participant_affiliation_updated",
            actorAgentId: joiner.id,
            subjectType: "playground_session",
            subjectId: session.id,
            schoolId: "foundation",
            payload: { fields: ["__STORE_ASSIGNED__"] },
          },
        ],
      }
    );
    expect(outcome.result).toBe("affiliation_updated");

    const emitted = (await eventsSince(marker)).filter(
      (e) => e.kind === "playground.participant_affiliation_updated"
    );
    expect(emitted).toHaveLength(1);
    // The store filled `fields` from its own before/after diff; the action's marker never lands.
    expect(emitted[0].payload).toEqual({ fields: ["actingAsDisplaySummary", "actingAsLabel"] });

    // Identical fields the second time: no write, no event.
    const repeatMarker = await maxEventId();
    const repeat = await joinPlaygroundSessionWithOutcome(
      session.id,
      {
        agentId: joiner.id,
        agentName: joiner.name,
        status: "active",
        actingAsLabel: "Acme",
        actingAsDisplaySummary: "Acting for Acme",
      } as SessionParticipant,
      6,
      {
        affiliationUpdated: [
          {
            kind: "playground.participant_affiliation_updated",
            actorAgentId: joiner.id,
            subjectType: "playground_session",
            subjectId: session.id,
            schoolId: "foundation",
            payload: { fields: ["__STORE_ASSIGNED__"] },
          },
        ],
      }
    );
    expect(repeat.result).toBe("unchanged");
    expect(await eventsSince(repeatMarker)).toEqual([]);
  });

  it("classifies a full session from its OWN locked snapshot, writing nothing", async () => {
    const members = await Promise.all(Array.from({ length: 6 }, () => seedAgent()));
    const outsider = await seedAgent();
    await retireLiveSessions("foundation");
    const session = await seedSession({ participants: members, schoolId: "foundation" });
    const marker = await maxEventId();

    const result = await joinSession({ agent: outsider, sessionId: session.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("Session full");
    expect(await participantsOf(session.id)).toHaveLength(6);
    expect(await eventsSince(marker)).toEqual([]);
  });
});

describe("submitAction — the gated insert's CTE", () => {
  it("emits one action_submitted carrying the triple and the idem key", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const marker = await maxEventId();

    const result = await submitAction({ agent, sessionId: session.id, content: "my move" });
    expect(result.ok).toBe(true);

    const emitted = (await eventsSince(marker)).filter((e) => e.kind === "playground.action_submitted");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ session_id: session.id, round: 1, agent_id: agent.id });
    expect(emitted[0].idemKey).toBe(`playground_action:${session.id}:1:${agent.id}`);
    if (result.ok) {
      expect(await sourceEventId("playground_action", result.data.action.id)).toBe(emitted[0].id);
    }
  });

  it("admits ONE of four concurrent submissions and emits exactly one event", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const marker = await maxEventId();

    const outcomes = await runConcurrently(
      Array.from({ length: 4 }, (_, i) => () =>
        submitAction({ agent, sessionId: session.id, content: `move ${i}` })
      )
    );
    // The losers are REFUSALS, not rejections: `ON CONFLICT DO NOTHING` means nobody raises 23505,
    // which is the change that lets the event ride the same statement.
    expect(rejections(outcomes)).toEqual([]);
    const admitted = outcomes.filter((o) => o.ok && o.value.ok);
    expect(admitted).toHaveLength(1);

    expect(await actionRows(session.id)).toBe(1);
    const emitted = (await eventsSince(marker)).filter((e) => e.kind === "playground.action_submitted");
    expect(emitted).toHaveLength(1);
  });
});

describe("cancelSession — the containment predicate IS the gate", () => {
  it("cancels for a participant and emits one event; the trail row survives, reading 'cancelled'", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const marker = await maxEventId();

    const result = await cancelSession({ agent, sessionId: session.id, reason: "done" });
    expect(result.ok && result.data.outcome).toBe("cancelled");

    const emitted = (await eventsSince(marker)).filter((e) => e.kind === "playground.session_cancelled");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actorAgentId).toBe(agent.id);

    const trail = await readActivity("playground_session", session.id);
    // Upsert, NOT deletion (M11-1 C3): the row is still there and its title carries the status.
    expect(trail).not.toBeNull();
    expect(String(trail!.title)).toContain("cancelled");
    expect(await sourceEventId("playground_session", session.id)).toBe(emitted[0].id);
  });

  it("writes no tuple and emits nothing for a NONPARTICIPANT", async () => {
    const participant = await seedAgent();
    const outsider = await seedAgent();
    const session = await seedSession({ status: "active", participants: [participant] });
    const marker = await maxEventId();

    const result = await cancelSession({ agent: outsider, sessionId: session.id, reason: "mine" });
    expect(result.ok && result.data.outcome).toBe("not_found");
    expect((await getPlaygroundSession(session.id))!.status).toBe("active");
    expect(await eventsSince(marker)).toEqual([]);
  });
});

describe("the sweeps", () => {
  it("emits ONE session_expired per expired session, each naming its own subject", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const first = await seedSession({ createdAt: old });
    const second = await seedSession({ createdAt: old });
    const fresh = await seedSession();
    const marker = await maxEventId();

    await runDeadlineProgressionUnlocked();

    const emitted = (await eventsSince(marker)).filter((e) => e.kind === "playground.session_expired");
    const mine = emitted.filter((e) => e.subjectId === first.id || e.subjectId === second.id);
    expect(mine).toHaveLength(2);
    expect(mine.every((e) => e.actorAgentId === null)).toBe(true);
    expect((await getPlaygroundSession(first.id))!.status).toBe("cancelled");
    expect((await getPlaygroundSession(fresh.id))!.status).toBe("pending");
    // Each session's trail row is stamped by ITS OWN event — correlated by subject, never position.
    for (const event of mine) {
      expect(await sourceEventId("playground_session", event.subjectId!)).toBe(event.id);
    }
  });

  it("caps an over-age session once, with reason lifetime_cap", async () => {
    const agent = await seedAgent();
    const session = await seedSession({
      status: "active",
      participants: [agent],
      startedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    });
    const marker = await maxEventId();

    await enforceSessionLifetimeCap();

    const emitted = (await eventsSince(marker)).filter(
      (e) => e.kind === "playground.session_completed" && e.subjectId === session.id
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ reason: "lifetime_cap" });
    expect((await getPlaygroundSession(session.id))!.status).toBe("completed");

    // The predicate is the gate: a second sweep completes nothing and emits nothing for it.
    const second = await maxEventId();
    await enforceSessionLifetimeCap();
    expect(
      (await eventsSince(second)).filter((e) => e.subjectId === session.id)
    ).toEqual([]);
  });

  /**
   * **The starvation case** (u3d fix round, finding 4).
   *
   * The sweep used to read the 50 NEWEST active sessions (`created_at DESC`) and filter them by age
   * in JavaScript. The overdue session below is created FIRST, so all fifty younger ones sit ahead of
   * it in that ordering and it falls outside the window entirely — every sweep skipped it, and with
   * continuous creation it would never be examined again. The store now answers with the sessions
   * that are DUE, oldest first.
   *
   * Fifty distinct schools, because `idx_pg_sessions_one_live_per_school` (M11-1 C23) admits one live
   * session per school.
   */
  it("caps the OLDEST overdue session from behind fifty younger active ones", async () => {
    const overdue = await seedSession({
      status: "active",
      startedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
    });
    const younger: string[] = [];
    for (let i = 0; i < 50; i += 1) younger.push((await seedSession({ status: "active" })).id);
    const marker = await maxEventId();

    await enforceSessionLifetimeCap();

    const emitted = (await eventsSince(marker)).filter(
      (e) => e.kind === "playground.session_completed" && e.subjectId === overdue.id
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toEqual({ reason: "lifetime_cap" });
    expect((await getPlaygroundSession(overdue.id))!.status).toBe("completed");
    // The fifty are under the cap and are left exactly as they were.
    expect(
      (await eventsSince(marker)).filter(
        (e) => e.kind === "playground.session_completed" && e.subjectId !== overdue.id
      )
    ).toEqual([]);

    // Retired now that this gate has finished asserting on them (u5 lane C). Fifty LIVE sessions
    // are this test's fixture, not a state any later test in this file means to inherit — and every
    // later `runDeadlineProgressionUnlocked()` pays for them, because the deadline sweep is O(active sessions) in
    // Neon HTTP round trips. Leaving them behind pushed the shadow-parity gates past their per-test
    // budget. `status` is moved directly rather than through a store writer, so nothing is emitted
    // and no gate below sees a fabricated transition.
    await pgPool().query(
      `UPDATE playground_sessions SET status = 'completed', completed_at = NOW() WHERE id = ANY($1::text[])`,
      [younger]
    );
  });
});

describe("shadow parity through the real drain", () => {
  async function shadowRows(eventId: number): Promise<
    Array<{
      consumer: string;
      effect_key: string;
      payload: Record<string, unknown>;
      legacy_match: string | null;
    }>
  > {
    const { rows } = await pgPool().query(
      `SELECT consumer, effect_key, payload, legacy_match FROM event_consumer_shadow
       WHERE event_id = $1 ORDER BY consumer, effect_key`,
      [eventId]
    );
    return rows as Array<{
      consumer: string;
      effect_key: string;
      payload: Record<string, unknown>;
      legacy_match: string | null;
    }>;
  }

  async function receipted(eventId: number): Promise<string[]> {
    const { rows } = await pgPool().query<{ consumer: string }>(
      `SELECT consumer FROM event_receipts WHERE event_id = $1 ORDER BY consumer`,
      [eventId]
    );
    return rows.map((row) => row.consumer);
  }

  /**
   * Drain until nothing moves — **a single pass is not enough on a shared database.**
   *
   * `drainEventConsumer` processes one batch per call, and the reserved database carries every other
   * suite's events between this consumer's activation fence and the event under test. One pass left
   * the cursor short of it, and the assertion then reported "no receipt" for an event the drain had
   * simply not reached yet — a harness artifact indistinguishable from a real dispatch failure.
   */
  async function drainAll(): Promise<void> {
    for (const consumer of eventConsumers) {
      for (let pass = 0; pass < 50; pass += 1) {
        const counts = await drainEventConsumer(consumer, { batchSize: 500 });
        if (counts.processed === 0) break;
      }
    }
  }

  /** Drop the paths a shadow row legitimately may not match — the consumer's own declaration. */
  function strip(kind: string, row: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...row };
    for (const path of activityTrailEffects.volatileShadowFields?.[
      kind as keyof NonNullable<typeof activityTrailEffects.volatileShadowFields>
    ] ?? [])
      delete copy[path];
    return copy;
  }

  beforeAll(async () => {
    await activateRealConsumers();
  });

  it("records a session-lifecycle shadow row matching the legacy projection, occurred_at included", async () => {
    const joiner = await seedAgent();
    await retireLiveSessions("foundation");
    const session = await seedSession({ schoolId: "foundation" });
    const marker = await maxEventId();
    await joinSession({ agent: joiner, sessionId: session.id });

    const [event] = (await eventsSince(marker)).filter((e) => e.kind === "playground.session_joined");
    const legacy = await readActivity("playground_session", session.id);
    expect(legacy).not.toBeNull();

    await drainAll();

    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);
    // Only the activity trail has an effect for this kind; the other two are `none`.
    expect(shadow.map((row) => row.consumer)).toEqual(["activity-trail"]);
    expect(shadow[0].effect_key).toBe(`playground_session:${session.id}`);
    expect(shadow[0].payload).toEqual(strip("playground.session_joined", legacy!));
    // The drain-time comparison agrees, which is the signal the soak aggregates.
    expect(shadow[0].legacy_match).toBe("matched");
    // The SUBJECT's own clock, shared by both writers — which is how these kinds cleared
    // `OCCURRED_AT_STAMP_PENDING_KINDS` without a stamp.
    expect(shadow[0].payload.occurred_at).toBe(legacy!.occurred_at);
  });

  it("resolves the action row from the event's triple and matches its legacy projection", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const marker = await maxEventId();
    const result = await submitAction({ agent, sessionId: session.id, content: "shadow move" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [event] = (await eventsSince(marker)).filter((e) => e.kind === "playground.action_submitted");
    const legacy = await readActivity("playground_action", result.data.action.id);
    expect(legacy).not.toBeNull();

    await drainAll();

    expect(await receipted(event.id)).toEqual([...REAL_CONSUMERS].sort());
    const shadow = await shadowRows(event.id);
    // `memory-ingest` is `legacy` for this kind (recorded deviation), so it receipts and shadows
    // nothing; only the trail describes an effect.
    expect(shadow.map((row) => row.consumer)).toEqual(["activity-trail"]);
    // The event carries no action id: the key proves the consumer resolved the row by the triple.
    expect(shadow[0].effect_key).toBe(`playground_action:${result.data.action.id}`);
    expect(shadow[0].payload).toEqual(strip("playground.action_submitted", legacy!));
    expect(shadow[0].legacy_match).toBe("matched");
    expect(shadow[0].payload.occurred_at).toBe(legacy!.occurred_at);
  });

  /**
   * **Every `shadow` kind, through the real drain** — the gate says every one, not a representative.
   *
   * Six of the seven share one projection, so the risk they carry is not six different effects but
   * one dispatch arm that might not reach them: a kind missing from `plan`'s switch would describe
   * nothing, record no shadow row, and read as "clean" in the soak forever. Each kind therefore gets
   * its own fresh session and its own drain, and the assertion is a MATCHED row under the session's
   * key — which is only produced when the consumer planned the effect AND the legacy twin at that
   * key was stamped by this very event.
   */
  it.each([
    [
      "playground.session_created",
      async (agent: StoredAgent) => (await seedSession({ participants: [agent] })).id,
    ],
    [
      "playground.session_cancelled",
      async (agent: StoredAgent) => {
        const session = await seedSession({ status: "active", participants: [agent] });
        await cancelSession({ agent, sessionId: session.id, reason: "soak" });
        return session.id;
      },
    ],
    [
      "playground.session_expired",
      async (agent: StoredAgent) => {
        const session = await seedSession({
          participants: [agent],
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        });
        await runDeadlineProgressionUnlocked();
        return session.id;
      },
    ],
    [
      "playground.session_completed",
      async (agent: StoredAgent) => {
        const session = await seedSession({
          status: "active",
          participants: [agent],
          startedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
        });
        await enforceSessionLifetimeCap();
        return session.id;
      },
    ],
  ])("records a matched shadow row for %s", async (kind, produce) => {
    const agent = await seedAgent();
    const marker = await maxEventId();
    const sessionId = await (produce as (a: StoredAgent) => Promise<string>)(agent);

    const [event] = (await eventsSince(marker)).filter(
      (e) => e.kind === kind && e.subjectId === sessionId
    );
    expect(event).toBeDefined();
    const legacy = await readActivity("playground_session", sessionId);
    expect(legacy).not.toBeNull();

    await drainAll();

    const shadow = await shadowRows(event.id);
    expect(shadow.map((row) => row.consumer)).toEqual(["activity-trail"]);
    expect(shadow[0].effect_key).toBe(`playground_session:${sessionId}`);
    expect(shadow[0].payload).toEqual(strip(kind, legacy!));
    expect(shadow[0].legacy_match).toBe("matched");
    expect(shadow[0].payload.occurred_at).toBe(legacy!.occurred_at);
  });

  it("action → cancel → drain skips cleanly: a receipt, and no resurrection", async () => {
    const agent = await seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const marker = await maxEventId();
    const result = await submitAction({ agent, sessionId: session.id, content: "then cancelled" });
    expect(result.ok).toBe(true);

    await cancelSession({ agent, sessionId: session.id, reason: "changed my mind" });
    const events = await eventsSince(marker);
    const actionEvent = events.find((e) => e.kind === "playground.action_submitted")!;

    await drainAll();

    // Cancellation is a TRANSITION, so the action row survives and its event still has a subject to
    // project — the drain neither errors nor skips. What it must NOT do is resurrect a session
    // projection that says anything but "cancelled".
    expect(await receipted(actionEvent.id)).toEqual([...REAL_CONSUMERS].sort());
    const trail = await readActivity("playground_session", session.id);
    expect(String(trail!.title)).toContain("cancelled");
  });
});
