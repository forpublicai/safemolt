/**
 * M11-2 u3d (P1.4) — the playground action layer's gates, in memory mode.
 *
 * Every assertion here is about the COUPLING the chunk exists to establish: a mutation and its
 * event commit together, and a refused mutation writes nothing and emits nothing. The wire shapes
 * both surfaces answer with are pinned separately, in
 * `src/__tests__/api/v1/m11-2-u3d-playground-characterization.test.ts`.
 *
 * Memory mode is the mode Jest has, and it is not a lesser one here: the memory store carries the
 * same branch decisions as the db statements (Decision 4's preflight discipline exists precisely so
 * the two agree), and the in-process dispatcher runs the same consumers. What memory mode cannot
 * exercise is the SQL — the db statements' shape is asserted in
 * `src/__tests__/lib/store/playground-statement-shape.test.ts`, and their behavior under real
 * concurrency belongs to the integration suite.
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

import {
  cancelSession,
  createSession,
  joinSession,
  submitAction,
} from "@/lib/actions/playground";
import { checkDeadlines } from "@/lib/playground/session-manager";
import { enforceSessionLifetimeCap } from "@/lib/playground/lifecycle";
import { createPlaygroundSession, getPlaygroundSession } from "@/lib/store";
import type { PlaygroundSession, SessionParticipant } from "@/lib/playground/types";
import {
  activityEventKey,
  activityEventSourceIds,
  activityEvents,
  agents,
  eventLog,
  playgroundActions,
  playgroundSessions,
} from "@/lib/store/_memory-state";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `u3d${label}${Date.now().toString(36)}${(seq += 1)}`;

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);
const kindsSince = (since: number) => eventsSince(since).map((event) => event.kind);

function seedAgent(options: { admitted?: boolean } = {}): StoredAgent {
  const id = nextId("ag");
  const agent: StoredAgent = {
    id,
    name: id,
    description: "u3d gate fixture",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: options.admitted !== false,
  };
  agents.set(id, agent);
  return agent;
}

async function seedSession(options: {
  status?: PlaygroundSession["status"];
  participants?: StoredAgent[];
  schoolId?: string;
  gameId?: string;
  createdAt?: string;
  startedAt?: string;
} = {}): Promise<PlaygroundSession> {
  const id = nextId("sess");
  const status = options.status ?? "pending";
  const participants: SessionParticipant[] = (options.participants ?? []).map((a) => ({
    agentId: a.id,
    agentName: a.name,
    status: "active" as const,
    missedRounds: 0,
  }));
  const created = await createPlaygroundSession({
    id,
    // The game registry is school-scoped: `pub-debate` is Foundation's, and AO resolves only its
    // own YAML games. A fixture that names a school must name that school's game.
    gameId: options.gameId ?? "pub-debate",
    // Foundation by default, because the GAME registry is school-scoped and only real schools
    // resolve `pub-debate`. Tests that need several live sessions at once name their own school —
    // C23 allows one live session per school in both stores.
    schoolId: options.schoolId ?? "foundation",
    status,
    participants,
    currentRound: status === "active" ? 1 : 0,
    currentRoundPrompt: status === "active" ? "prompt" : undefined,
    roundDeadline: status === "active" ? new Date(Date.now() + 3_600_000).toISOString() : undefined,
    maxRounds: 6,
    startedAt: status === "active" ? options.startedAt ?? new Date().toISOString() : undefined,
  });
  if (options.createdAt) {
    playgroundSessions.set(id, { ...playgroundSessions.get(id)!, createdAt: options.createdAt });
  }
  if (options.startedAt) {
    playgroundSessions.set(id, { ...playgroundSessions.get(id)!, startedAt: options.startedAt });
  }
  return created;
}

/** The session's trail row and the event that stamped it. */
function sessionTrail(sessionId: string) {
  const key = activityEventKey("playground_session", sessionId);
  return { row: activityEvents.get(key), sourceEventId: activityEventSourceIds.get(key) };
}

beforeEach(() => {
  playgroundSessions.clear();
  playgroundActions.clear();
  activityEvents.clear();
  activityEventSourceIds.clear();
});

// ---------------------------------------------------------------------------
// creation
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("emits exactly one session_created, and the trail row is stamped by it", async () => {
    const agent = seedAgent();
    const since = marker();

    const result = await createSession({ agent, schoolId: "foundation", gameId: "pub-debate" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const emitted = eventsSince(since);
    expect(emitted.map((e) => e.kind)).toEqual(["playground.session_created"]);
    // The subject is the id the STORE minted — the action wrote a marker it could not know.
    expect(emitted[0].subjectId).toBe(result.data.session.id);
    expect(emitted[0].subjectType).toBe("playground_session");
    expect(emitted[0].actorAgentId).toBe(agent.id);

    // Transitional projection: written by the path that emitted the event, and stamped with its id.
    expect(sessionTrail(result.data.session.id).sourceEventId).toBe(emitted[0].id);
  });

  it("writes nothing and emits nothing when the school already has a live session", async () => {
    const agent = seedAgent();
    const schoolId = "foundation";
    await seedSession({ schoolId });
    const since = marker();

    const result = await createSession({ agent, schoolId });
    expect(result.ok).toBe(false);
    expect(eventsSince(since)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// join / affiliation — the single-statement branch pair
// ---------------------------------------------------------------------------

describe("joinSession", () => {
  it("emits session_joined once, and nothing at all on an identical re-join", async () => {
    const agent = seedAgent();
    const session = await seedSession();
    const since = marker();

    const first = await joinSession({ agent, sessionId: session.id });
    expect(first.ok).toBe(true);
    expect(kindsSince(since)).toEqual(["playground.session_joined"]);

    const afterJoin = marker();
    const second = await joinSession({ agent, sessionId: session.id });
    expect(second.ok).toBe(true);
    // Identical fields: no write, no event — and the trail's stamp does not move either.
    expect(eventsSince(afterJoin)).toEqual([]);
    expect((await getPlaygroundSession(session.id))!.participants).toHaveLength(1);
  });

  it("emits participant_affiliation_updated — and only that — when a re-join CHANGES fields", async () => {
    const agent = seedAgent();
    // Affiliation fields are accepted on AO sessions only, so this fixture has to be an AO one —
    // with an AO game, since the registry is school-scoped.
    const session = await seedSession({ schoolId: "ao", gameId: "ao-regulatory-assembly" });
    await joinSession({ agent, sessionId: session.id });
    const since = marker();

    const result = await joinSession({
      agent,
      sessionId: session.id,
      actingAsLabel: "Acme Robotics",
    });
    expect(result.ok).toBe(true);

    const emitted = eventsSince(since);
    expect(emitted.map((e) => e.kind)).toEqual(["playground.participant_affiliation_updated"]);
    // WHICH fields moved — the diff the statement made, never the fields the request offered. The
    // display summary is DERIVED from the label by `resolveActingJoinPayload`, so a request naming
    // one field legitimately moves two; sorted, so two identical refreshes record byte-identical
    // history (and so the memory list matches the db's `jsonb_agg … ORDER BY`).
    expect(emitted[0].payload).toEqual({
      fields: ["actingAsDisplaySummary", "actingAsLabel"],
    });
    expect(emitted[0].subjectId).toBe(session.id);

    const stored = (await getPlaygroundSession(session.id))!.participants[0];
    expect(stored.actingAsLabel).toBe("Acme Robotics");
    // The trail row is stamped by the affiliation event, not by the earlier join.
    expect(sessionTrail(session.id).sourceEventId).toBe(emitted[0].id);
  });

  it("refuses a full session with no write and no event", async () => {
    const outsider = seedAgent();
    const members = [seedAgent(), seedAgent(), seedAgent(), seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({ participants: members });
    const since = marker();

    const result = await joinSession({ agent: outsider, sessionId: session.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("Session full");
    expect(eventsSince(since)).toEqual([]);
    expect((await getPlaygroundSession(session.id))!.participants).toHaveLength(6);
  });

  it("refuses a school-denied agent before anything is written", async () => {
    const agent = seedAgent({ admitted: false });
    const session = await seedSession({ schoolId: "ao", gameId: "ao-regulatory-assembly" });
    const since = marker();

    const result = await joinSession({ agent, sessionId: session.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admission_required");
    expect(eventsSince(since)).toEqual([]);
    expect((await getPlaygroundSession(session.id))!.participants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// submitAction
// ---------------------------------------------------------------------------

describe("submitAction", () => {
  it("emits action_submitted once, carrying the triple and the idem key", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const since = marker();

    const result = await submitAction({ agent, sessionId: session.id, content: "my move" });
    expect(result.ok).toBe(true);

    const emitted = eventsSince(since);
    expect(emitted.map((e) => e.kind)).toEqual(["playground.action_submitted"]);
    expect(emitted[0].payload).toEqual({
      session_id: session.id,
      round: 1,
      agent_id: agent.id,
    });
    // Defense in depth: a producer retried across a crash cannot write the event twice.
    expect(emitted[0].idemKey).toBe(`playground_action:${session.id}:1:${agent.id}`);
    // The subject is the SESSION, not the action row — the event deliberately carries no row id.
    expect(emitted[0].subjectId).toBe(session.id);
  });

  it("emits nothing for the duplicate-race loser", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    await submitAction({ agent, sessionId: session.id, content: "first" });
    const since = marker();

    const second = await submitAction({ agent, sessionId: session.id, content: "second" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toBe("Agent already submitted an action for this round");
    expect(eventsSince(since)).toEqual([]);
  });

  it("emits nothing for a nonparticipant", async () => {
    const participant = seedAgent();
    const outsider = seedAgent();
    const session = await seedSession({ status: "active", participants: [participant] });
    const since = marker();

    const result = await submitAction({ agent: outsider, sessionId: session.id, content: "x" });
    expect(result.ok).toBe(false);
    expect(eventsSince(since)).toEqual([]);
    expect(playgroundActions.size).toBe(0);
  });

  it("refuses the adapter's deferred input error AFTER the school gate, writing nothing", async () => {
    const denied = seedAgent({ admitted: false });
    const session = await seedSession({
      status: "active",
      participants: [denied],
      schoolId: "ao",
      gameId: "ao-regulatory-assembly",
    });
    const since = marker();

    const result = await submitAction({
      agent: denied,
      sessionId: session.id,
      content: "",
      refuseWith: 'Missing or empty "content" field',
    });
    expect(result.ok).toBe(false);
    // The GATE wins, which is Locked decision 3: a refused principal reaches no validation.
    if (!result.ok) expect(result.code).toBe("admission_required");
    expect(eventsSince(since)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

describe("cancelSession", () => {
  it("emits session_cancelled for a participant and stamps the refreshed trail row", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    const since = marker();

    const result = await cancelSession({ agent, sessionId: session.id, reason: "done" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("cancelled");

    const emitted = eventsSince(since);
    expect(emitted.map((e) => e.kind)).toEqual(["playground.session_cancelled"]);
    expect(emitted[0].actorAgentId).toBe(agent.id);

    const trail = sessionTrail(session.id);
    expect(trail.sourceEventId).toBe(emitted[0].id);
    // The consumer effect is an UPSERT, not a deletion: the row survives and reads "cancelled".
    expect(trail.row?.title).toContain("cancelled");
    expect(trail.row?.metadata?.status).toBe("cancelled");
  });

  it("changes no session and emits nothing for a NONPARTICIPANT", async () => {
    const participant = seedAgent();
    const outsider = seedAgent();
    const session = await seedSession({ status: "active", participants: [participant] });
    const since = marker();

    const result = await cancelSession({ agent: outsider, sessionId: session.id, reason: "mine" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("not_found");
    expect(eventsSince(since)).toEqual([]);
    expect((await getPlaygroundSession(session.id))!.status).toBe("active");
  });

  it("emits nothing on a second cancellation", async () => {
    const agent = seedAgent();
    const session = await seedSession({ status: "active", participants: [agent] });
    await cancelSession({ agent, sessionId: session.id, reason: "first" });
    const since = marker();

    const again = await cancelSession({ agent, sessionId: session.id, reason: "second" });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.outcome).toBe("not_cancellable");
    expect(eventsSince(since)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the sweeps
// ---------------------------------------------------------------------------

describe("the expiry sweep", () => {
  it("emits ONE session_expired per expired session, each naming its own subject", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const first = await seedSession({ createdAt: old, schoolId: "sweep_a" });
    const second = await seedSession({ createdAt: old, schoolId: "sweep_b" });
    // A fresh pending session in a third school must be untouched.
    const fresh = await seedSession({ schoolId: "sweep_c" });
    const since = marker();

    await checkDeadlines();

    const emitted = eventsSince(since).filter((e) => e.kind === "playground.session_expired");
    expect(emitted).toHaveLength(2);
    // Correlated by SUBJECT, never by position — the fan-out's own rule.
    expect(emitted.map((e) => e.subjectId).sort()).toEqual([first.id, second.id].sort());
    // A system expiry has no actor; that is what tells it from a participant's cancellation.
    expect(emitted.every((e) => e.actorAgentId === null)).toBe(true);

    expect((await getPlaygroundSession(first.id))!.status).toBe("cancelled");
    expect((await getPlaygroundSession(fresh.id))!.status).toBe("pending");
    // Each session's trail row is stamped by ITS OWN event.
    for (const event of emitted) {
      expect(sessionTrail(event.subjectId!).sourceEventId).toBe(event.id);
    }
  });

  it("emits nothing on a second pass", async () => {
    await seedSession({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), schoolId: "sweep_d" });
    await checkDeadlines();
    const since = marker();

    await checkDeadlines();
    expect(eventsSince(since).filter((e) => e.kind === "playground.session_expired")).toEqual([]);
  });
});

describe("the lifetime cap", () => {
  it("completes an over-age session with reason lifetime_cap, once", async () => {
    const agent = seedAgent();
    const old = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const session = await seedSession({ status: "active", participants: [agent], startedAt: old });
    const since = marker();

    expect(await enforceSessionLifetimeCap()).toEqual({ completed: 1 });

    const emitted = eventsSince(since);
    expect(emitted.map((e) => e.kind)).toEqual(["playground.session_completed"]);
    expect(emitted[0].payload).toEqual({ reason: "lifetime_cap" });
    expect(emitted[0].subjectId).toBe(session.id);
    expect((await getPlaygroundSession(session.id))!.status).toBe("completed");

    // A second sweep finds nothing to cap: the predicate is the gate, so no second event exists.
    const afterCap = marker();
    expect(await enforceSessionLifetimeCap()).toEqual({ completed: 0 });
    expect(eventsSince(afterCap)).toEqual([]);
  });
});
