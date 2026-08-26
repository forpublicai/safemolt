/**
 * M11-2 u5 lane C (P3.2) — the `playground.round_opened` PRODUCERS, in memory mode.
 *
 * The kind's contract is a timing one: the event is emitted by the write that DURABLY STORES a
 * round's prompt, never by a promptless status flip, so a wakeup can never exist for a round nobody
 * can act on yet. Everything below is an assertion about that coupling rather than about a code
 * path:
 *
 *  - **activation no longer claims a deadline.** `activateSession` used to set `round_deadline`
 *    and only then generate the prompt asynchronously, so after an outage the deadline could expire
 *    on a round no participant could ever act on. The clock now starts when the prompt is published.
 *  - **round-1 prompt storage is ONE conditional write**, shared by the activation path and the
 *    repair sweep: exactly one writer wins, the loser writes nothing and emits nothing.
 *  - **the repair sweep** regenerates a round-1 prompt whose async write crashed, past a grace.
 *  - **the rollout bridge** gives an active, PROMPTED round that predates this kind exactly one
 *    synthetic event, and repeated sweeps add no more.
 *  - **the sweep creates-or-re-arms wakeups** for active, un-acted participants of the current
 *    round, keyed by that round's event id.
 *
 * The first gate is a CHARACTERIZATION pin, evolved deliberately: it asserted `roundDeadline`
 * present at the status flip and NO `round_opened` after the prompt write against the pre-change
 * tree, and it now asserts the mirror image. Both versions were run.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

/**
 * The GM prompt call is DEFERRED on purpose.
 *
 * The whole point of the first gate is the window BETWEEN the status flip and the prompt write —
 * with an immediately-resolving mock that window closes on the next microtask and cannot be
 * observed at all. Each call parks its resolver, and the test releases them one at a time, which is
 * also what makes the round-1 prompt RACE expressible without a second connection.
 */
const promptDeferrals: Array<(prompt: string) => void> = [];
jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(
    () =>
      new Promise<string>((resolve) => {
        promptDeferrals.push(resolve);
      })
  ),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

import { checkDeadlines } from "@/lib/playground/session-manager";
import { createPlaygroundSession, getPlaygroundSession } from "@/lib/store";
import {
  agents,
  eventLog,
  playgroundActions,
  playgroundSessions,
  resetWakeupState,
  wakeupQueue,
} from "@/lib/store/_memory-state";
import type { PlaygroundSession, SessionAction, SessionParticipant } from "@/lib/playground/types";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `u5c${label}${Date.now().toString(36)}${(seq += 1)}`;

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);
const roundOpenedSince = (since: number) =>
  eventsSince(since).filter((event) => event.kind === "playground.round_opened");

/** Let a `safeWaitUntil`-scheduled continuation, or an in-flight sweep, run to its next await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Resolve the OLDEST outstanding GM prompt call, then let its continuation land. */
async function deliverPrompt(prompt: string): Promise<void> {
  const resolve = promptDeferrals.shift();
  if (!resolve) throw new Error("no outstanding generateRoundPrompt call to resolve");
  resolve(prompt);
  await settle();
}

function seedAgent(): StoredAgent {
  const id = nextId("ag");
  const agent: StoredAgent = {
    id,
    name: id,
    description: "u5c round-opened fixture",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
    isAdmitted: true,
  };
  agents.set(id, agent);
  return agent;
}

/**
 * A session in Foundation running `pub-debate` — the one game whose `minPlayers` (3) the
 * auto-activation step in `checkDeadlines` reads, so a fixture that wants activation seeds three.
 */
async function seedSession(options: {
  status?: PlaygroundSession["status"];
  participants?: StoredAgent[];
  currentRound?: number;
  currentRoundPrompt?: string;
  roundDeadline?: string;
  startedAt?: string;
  schoolId?: string;
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
    gameId: "pub-debate",
    schoolId: options.schoolId ?? "foundation",
    status,
    participants,
    currentRound: options.currentRound ?? (status === "active" ? 1 : 0),
    currentRoundPrompt: options.currentRoundPrompt,
    roundDeadline: options.roundDeadline,
    maxRounds: 6,
    startedAt: status === "active" ? options.startedAt ?? new Date().toISOString() : undefined,
  });
  if (options.startedAt) {
    playgroundSessions.set(id, { ...playgroundSessions.get(id)!, startedAt: options.startedAt });
  }
  return created;
}

/** Push `startedAt` into the past so the repair sweep's grace has elapsed. */
function ageSession(sessionId: string, ms: number): void {
  const session = playgroundSessions.get(sessionId)!;
  playgroundSessions.set(sessionId, {
    ...session,
    startedAt: new Date(Date.now() - ms).toISOString(),
  });
}

function seedAction(sessionId: string, agentId: string, round: number): void {
  const action: SessionAction = {
    id: nextId("act"),
    sessionId,
    agentId,
    round,
    content: "already acted",
    createdAt: new Date().toISOString(),
  };
  playgroundActions.set(action.id, action);
}

const wakeupsFor = (sessionId: string) =>
  Array.from(wakeupQueue.rows.values()).filter(
    (row) => (row.payload as { session_id?: string }).session_id === sessionId
  );

beforeEach(() => {
  playgroundSessions.clear();
  playgroundActions.clear();
  agents.clear();
  resetWakeupState();
  promptDeferrals.length = 0;
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION — activation's deadline, and the round-1 prompt write
// ---------------------------------------------------------------------------

describe("activation and the round-1 prompt write", () => {
  it("starts the round's clock when the PROMPT lands, not at the status flip", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({ participants });
    const since = marker();

    // Auto-activation (`checkDeadlines` step 1b) flips the session and schedules the prompt.
    await checkDeadlines();

    const activated = (await getPlaygroundSession(session.id))!;
    expect(activated.status).toBe("active");
    expect(activated.currentRound).toBe(1);
    expect(activated.currentRoundPrompt).toBeUndefined();
    // The pin, evolved. It read `expect(typeof activated.roundDeadline).toBe("string")` against the
    // pre-change tree — the flip claimed a deadline ahead of any prompt a participant could act on,
    // so an outage could expire a round nobody could ever have played.
    expect(activated.roundDeadline).toBeUndefined();
    // No round_opened either way at this point: there is no stored prompt.
    expect(roundOpenedSince(since)).toEqual([]);

    await deliverPrompt("round 1 prompt");

    const prompted = (await getPlaygroundSession(session.id))!;
    expect(prompted.currentRoundPrompt).toBe("round 1 prompt");
    // Publication is what starts the clock.
    expect(typeof prompted.roundDeadline).toBe("string");
    expect(Date.parse(prompted.roundDeadline!)).toBeGreaterThan(Date.now());

    // The pin, evolved. It read `expect(roundOpenedSince(since)).toEqual([])` against the
    // pre-change tree: the prompt write was an unconditional `updatePlaygroundSession` carrying no
    // event at all.
    const opened = roundOpenedSince(since);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    expect(opened[0].subjectType).toBe("playground_session");
    expect(opened[0].subjectId).toBe(session.id);
    // Nobody OPENS a round — the GM/system does, the same NULL actor the other sweep kinds carry.
    expect(opened[0].actorAgentId).toBeNull();
    // The two REAL producers carry no idem key: their uniqueness is the statement's predicate.
    expect(opened[0].idemKey).toBeNull();
  });

  /**
   * **The round-1 prompt race** — a slow activation writer against the sweep's repair.
   *
   * Both generations are in flight at once; the conditional write is what decides. Exactly one
   * prompt is stored and exactly one event exists, because the loser's predicate
   * (`current_round_prompt IS NULL`) no longer holds.
   */
  it("stores ONE prompt and emits ONE event when activation races the repair sweep", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({ participants });

    await checkDeadlines(); // activation; its generation is deferral #1
    ageSession(session.id, 5 * 60 * 1000); // past the repair grace
    const since = marker();

    const sweep = checkDeadlines(); // the repair's generation is deferral #2
    await settle();
    expect(promptDeferrals).toHaveLength(2);

    await deliverPrompt("activation prompt"); // #1 wins the predicate
    await deliverPrompt("repair prompt"); // #2 finds the prompt already stored
    await sweep;

    const stored = (await getPlaygroundSession(session.id))!;
    expect(stored.currentRoundPrompt).toBe("activation prompt");
    expect(roundOpenedSince(since)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the repair sweep
// ---------------------------------------------------------------------------

describe("the round-1 prompt repair sweep", () => {
  it("republishes a crashed round-1 prompt past the grace, with its event and a fresh deadline", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    // An activation whose continuation never ran: active, round 1, no prompt, no deadline.
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    const since = marker();

    const sweep = checkDeadlines();
    await settle();
    await deliverPrompt("repaired prompt");
    await sweep;

    const repaired = (await getPlaygroundSession(session.id))!;
    expect(repaired.currentRoundPrompt).toBe("repaired prompt");
    // A late recovery publishes into a FRESH deadline — never into one that already expired.
    expect(Date.parse(repaired.roundDeadline!)).toBeGreaterThan(Date.now());

    const opened = roundOpenedSince(since);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({ session_id: session.id, round: 1 });
    // The repair is a REAL producer, so it carries no `reconstructed` flag and no idem key.
    expect(opened[0].idemKey).toBeNull();
  });

  it("leaves a session inside the grace alone", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const since = marker();

    await checkDeadlines();

    expect(promptDeferrals).toHaveLength(0);
    expect((await getPlaygroundSession(session.id))!.currentRoundPrompt).toBeUndefined();
    expect(roundOpenedSince(since)).toEqual([]);
  });

  /**
   * A promptless active round is UN-EXPIRABLE. Its deadline is absent, so `tryAdvanceRound`'s
   * deadline branch cannot fire and the round is never forfeited out from under participants who
   * never had a prompt to answer.
   */
  it("never advances or forfeits a promptless round", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    const sweep = checkDeadlines();
    await settle();
    await deliverPrompt("repaired prompt");
    const result = await sweep;

    expect(result.advanced).toBe(0);
    const after = (await getPlaygroundSession(session.id))!;
    expect(after.currentRound).toBe(1);
    expect(after.participants.every((p) => p.status === "active")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the rollout bridge
// ---------------------------------------------------------------------------

describe("the rollout bridge", () => {
  it("reconstructs exactly one round_opened for a prompted round that predates the kind", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      currentRound: 3,
      currentRoundPrompt: "pre-M11 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const since = marker();

    await checkDeadlines();

    const opened = roundOpenedSince(since);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toEqual({
      session_id: session.id,
      round: 3,
      reconstructed: true,
    });
    expect(opened[0].subjectId).toBe(session.id);
    expect(opened[0].idemKey).toBe(`playground_round_opened:${session.id}:3`);

    // Repeated passes converge, and TWICE OVER: the locator finds the event so the bridge does not
    // reach `emitEvent` at all, and the idem key would refuse the write even if it did. Removing
    // either guard alone still converges here — what a lost locator check actually costs is a second
    // event for every OTHER active prompted session on every pass, which the repair gates above see.
    const afterFirst = marker();
    await checkDeadlines();
    expect(roundOpenedSince(afterFirst)).toEqual([]);
  });

  it("skips a still-promptless round — the repair owns that one", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 30_000).toISOString(), // inside the repair grace
    });
    const since = marker();

    await checkDeadlines();

    expect(roundOpenedSince(since)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create-or-re-arm
// ---------------------------------------------------------------------------

describe("the sweep's wakeup arming", () => {
  it("arms every active, un-acted participant against the round's event id, once", async () => {
    const [first, second, third] = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants: [first, second, third],
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // One participant already acted this round: waking them would spend a budget claim on a turn
    // `submitAction` must reject as a duplicate.
    seedAction(session.id, third.id, 2);
    const since = marker();

    // Pass one: the bridge mints the round's event, then the arming keys off it.
    await checkDeadlines();

    const eventId = roundOpenedSince(since)[0].id;
    const armed = wakeupsFor(session.id);
    expect(armed.map((row) => row.agentId).sort()).toEqual([first.id, second.id].sort());
    expect(armed.every((row) => row.reason === "playground_round")).toBe(true);
    expect(armed.every((row) => row.eventId === eventId)).toBe(true);
    expect(armed.every((row) => row.delivery === "internal")).toBe(true);
    expect(armed.every((row) => row.completedAt === null)).toBe(true);
    expect(armed[0].payload).toEqual({ session_id: session.id, round: 2 });

    // Pass two adds nothing: the `(agent, reason, event_id)` dedup holds and a still-pending row is
    // not re-armable.
    await checkDeadlines();
    expect(wakeupsFor(session.id)).toHaveLength(2);
  });

  it("re-arms a completed, un-acted turn so a lost runner cannot strand a round", async () => {
    const [first, second, third] = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants: [first, second, third],
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await checkDeadlines();
    const target = wakeupsFor(session.id).find((row) => row.agentId === first.id)!;
    // A tick that ran and failed — the only state P3.3 can produce, seeded directly because no
    // production code here writes a completion yet.
    target.completedAt = new Date().toISOString();
    target.result = "error";

    await checkDeadlines();

    const reArmed = wakeupsFor(session.id).find((row) => row.id === target.id)!;
    expect(reArmed.completedAt).toBeNull();
    expect(reArmed.result).toBeNull();
    // Still ONE row per participant: re-arm reuses the row the dedup index pins.
    expect(wakeupsFor(session.id)).toHaveLength(3);
  });

  it("arms nobody while the round is promptless", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 30_000).toISOString(),
    });

    await checkDeadlines();

    expect(wakeupsFor(session.id)).toEqual([]);
  });

  it("skips a forfeited participant", async () => {
    const [first, second, third] = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants: [first, second, third],
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const stored = playgroundSessions.get(session.id)!;
    playgroundSessions.set(session.id, {
      ...stored,
      participants: stored.participants.map((p) =>
        p.agentId === third.id ? { ...p, status: "forfeited" as const, forfeitedAtRound: 1 } : p
      ),
    });

    await checkDeadlines();

    expect(wakeupsFor(session.id).map((row) => row.agentId).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });
});
