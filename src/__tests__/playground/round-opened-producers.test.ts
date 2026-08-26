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
 * **E fix round 2 adds the STALE-SIGNAL cases** (findings 1 and 2). Every claim in this sweep is
 * preceded by at least one store read, and a read is a network round trip in production — so the
 * caller's per-session "stop claiming" check is already stale by the time the claim is reached, and
 * a sweep that lost its singleton lock during the read went on to activate a lobby, publish a
 * reconstructed event and arm wakeups under a lock a contender owns. Those three claims now re-read
 * the signal immediately before themselves, and the only way to tell such a check from the caller's
 * is a signal that flips DURING the read in between — which is what the pass-through store mock
 * below exists for. This file owns them because it is the memory-mode suite that already drives all
 * three phases end to end through `runDeadlineProgressionUnlocked`; the cap sweep's twin property
 * lives with the cap sweep, in `src/__tests__/lib/playground/lifecycle.test.ts`.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

/**
 * A PASS-THROUGH partial mock of the store (E fix round 2, findings 1 and 2).
 *
 * Every export stays the real memory-mode one. Three are wrapped in `jest.fn` so a case can make the
 * "stop claiming" signal flip DURING the store read that a claim sits behind — the eligibility read
 * before an activation, the locator read before the bridge's emit, and the wakeup write itself, so
 * the participant AFTER the one already in flight is the observable. Nothing else in this file
 * behaves differently: `beforeEach` reinstates the pass-through implementations, so every other case
 * runs against the real functions.
 */
jest.mock("@/lib/store", () => {
  const actual = jest.requireActual<typeof import("@/lib/store")>("@/lib/store");
  return {
    ...actual,
    getPlaygroundSession: jest.fn(actual.getPlaygroundSession),
    findRoundOpenedEventId: jest.fn(actual.findRoundOpenedEventId),
    createOrReArmPlaygroundRoundWakeup: jest.fn(actual.createOrReArmPlaygroundRoundWakeup),
  };
});

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

import { runDeadlineProgressionUnlocked } from "@/lib/playground/session-manager";
import {
  createOrReArmPlaygroundRoundWakeup,
  createPlaygroundSession,
  findRoundOpenedEventId,
  getPlaygroundSession,
} from "@/lib/store";
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
 * auto-activation step in `runDeadlineProgressionUnlocked` reads, so a fixture that wants activation seeds three.
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

/**
 * The real store, for two jobs: reinstating the pass-throughs above, and reading state back in a
 * stale-signal case WITHOUT tripping the very wrapper that case installed.
 */
const actualStore = jest.requireActual<typeof import("@/lib/store")>("@/lib/store");

beforeEach(() => {
  playgroundSessions.clear();
  playgroundActions.clear();
  agents.clear();
  resetWakeupState();
  promptDeferrals.length = 0;
  jest.mocked(getPlaygroundSession).mockImplementation(actualStore.getPlaygroundSession);
  jest.mocked(findRoundOpenedEventId).mockImplementation(actualStore.findRoundOpenedEventId);
  jest
    .mocked(createOrReArmPlaygroundRoundWakeup)
    .mockImplementation(actualStore.createOrReArmPlaygroundRoundWakeup);
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION — activation's deadline, and the round-1 prompt write
// ---------------------------------------------------------------------------

describe("activation and the round-1 prompt write", () => {
  it("starts the round's clock when the PROMPT lands, not at the status flip", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({ participants });
    const since = marker();

    // Auto-activation (`runDeadlineProgressionUnlocked` step 1b) flips the session and schedules the prompt.
    await runDeadlineProgressionUnlocked();

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
   * u6 E fix round 2, finding 1 (BLOCKER) — **the signal is re-read AFTER the eligibility read, not
   * only before it.**
   *
   * The activation scan checked the signal per pending session and then called a helper that spends
   * a store round trip re-reading that session fresh. A renewal failing inside that window left the
   * check's answer stale, and the very next statement transitioned the session and bought the round-1
   * GM prompt — under a lock a contender already owns, duplicating the exact inference the lock
   * exists to prevent.
   *
   * The flip rides on the eligibility read itself, because that is the whole window: nothing else
   * runs between the caller's check and the claim. The fixture is eligible (`pub-debate` wants three
   * players and has three), so a sweep that ignored the signal would certainly activate it.
   */
  it("activates nothing when the signal flips DURING the eligibility read", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({ participants });
    let lockLost = false;
    jest.mocked(getPlaygroundSession).mockImplementation(async (id) => {
      const fresh = await actualStore.getPlaygroundSession(id);
      if (id === session.id) lockLost = true;
      return fresh;
    });
    const since = marker();

    await runDeadlineProgressionUnlocked(() => lockLost);
    await settle();

    // Untouched, not merely "not completed": no status flip, no GM prompt bought, no event.
    expect((await actualStore.getPlaygroundSession(session.id))!.status).toBe("pending");
    expect(promptDeferrals).toHaveLength(0);
    expect(roundOpenedSince(since)).toEqual([]);
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

    await runDeadlineProgressionUnlocked(); // activation; its generation is deferral #1
    ageSession(session.id, 5 * 60 * 1000); // past the repair grace
    const since = marker();

    const sweep = runDeadlineProgressionUnlocked(); // the repair's generation is deferral #2
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

    const sweep = runDeadlineProgressionUnlocked();
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

  /**
   * **The codex u6-E r3 BLOCKER**: prompt generation is the LONGEST window in the sweep, and the
   * conditional write's `current_round_prompt IS NULL` predicate protects against a racing WRITER,
   * not against this worker publishing under a lock it lost mid-inference — the new owner may not
   * have written yet. The re-check after the GM call is what discards the stolen prompt.
   */
  it("discards a prompt generated across a LOST lock: no store, no deadline, no event", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    let lockLost = false;
    const since = marker();

    const sweep = runDeadlineProgressionUnlocked(() => lockLost);
    await settle();
    lockLost = true; // the lock is lost while the GM call is in flight
    await deliverPrompt("stolen prompt");
    await sweep;

    const after = (await getPlaygroundSession(session.id))!;
    expect(after.currentRoundPrompt).toBeUndefined();
    expect(after.roundDeadline).toBeUndefined();
    expect(roundOpenedSince(since)).toEqual([]);
  });

  it("leaves a session inside the grace alone", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const since = marker();

    await runDeadlineProgressionUnlocked();

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

    const sweep = runDeadlineProgressionUnlocked();
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

    await runDeadlineProgressionUnlocked();

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
    await runDeadlineProgressionUnlocked();
    expect(roundOpenedSince(afterFirst)).toEqual([]);
  });

  /**
   * u6 E fix round 2, finding 2 (BLOCKER) — **the bridge re-reads the signal before it publishes.**
   *
   * `bridgeAndArmSession` took no signal at all, so the caller's per-session check was the last one
   * before the locator read AND the emit behind it. A sweep whose renewal failed during that read
   * published a reconstructed `round_opened` — visible to every consumer, and duplicating what the
   * contender now holding the lock is emitting for the same round.
   *
   * The fixture is the bridge's own: a prompted round with no event, which the sweep certainly
   * reconstructs when the signal stays false (the case above this one).
   */
  it("emits nothing when the signal flips DURING the locator read", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants,
      currentRound: 3,
      currentRoundPrompt: "pre-M11 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let lockLost = false;
    jest.mocked(findRoundOpenedEventId).mockImplementation(async (sessionId, round) => {
      const found = await actualStore.findRoundOpenedEventId(sessionId, round);
      if (sessionId === session.id) lockLost = true;
      return found;
    });
    const since = marker();

    await runDeadlineProgressionUnlocked(() => lockLost);

    expect(roundOpenedSince(since)).toEqual([]);
    // And with no event id there is nothing to key a wakeup on, so the arming half stops with it.
    expect(wakeupsFor(session.id)).toEqual([]);
  });

  it("skips a still-promptless round — the repair owns that one", async () => {
    const participants = [seedAgent(), seedAgent(), seedAgent()];
    await seedSession({
      status: "active",
      participants,
      startedAt: new Date(Date.now() - 30_000).toISOString(), // inside the repair grace
    });
    const since = marker();

    await runDeadlineProgressionUnlocked();

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
    await runDeadlineProgressionUnlocked();

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
    await runDeadlineProgressionUnlocked();
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

    await runDeadlineProgressionUnlocked();
    const target = wakeupsFor(session.id).find((row) => row.agentId === first.id)!;
    // A tick that ran and failed — the only state P3.3 can produce, seeded directly because no
    // production code here writes a completion yet.
    target.completedAt = new Date().toISOString();
    target.result = "error";

    await runDeadlineProgressionUnlocked();

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

    await runDeadlineProgressionUnlocked();

    expect(wakeupsFor(session.id)).toEqual([]);
  });

  /**
   * u6 E fix round 2, finding 2 (BLOCKER), second half — **the check is PER WAKEUP.**
   *
   * Each participant costs a delivery read and then a write against that agent's tick budget, so one
   * check for the whole list is one check for N claims: a renewal failing at the first participant
   * still armed every remaining one. The signal flips inside the first write, which is where the
   * failure lands in production, and the assertion is the granularity — the claim already in flight
   * stands, the next one is never made.
   *
   * **Two sweeps, because the first one's arming is not the writer under test.** The bridge's emit
   * dispatches in-process here, and `wakeup-router.ts` arms the same participants from the event —
   * so a single-sweep fixture measures the CONSUMER. Clearing the queue and sweeping again leaves
   * the sweep's own loop alone with the work: the round's event now exists, so the bridge emits
   * nothing and dispatches nothing.
   */
  it("stops arming at the participant after the one already in flight", async () => {
    const [first, second, third] = [seedAgent(), seedAgent(), seedAgent()];
    const session = await seedSession({
      status: "active",
      participants: [first, second, third],
      currentRound: 2,
      currentRoundPrompt: "round 2 prompt",
      roundDeadline: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await runDeadlineProgressionUnlocked();
    expect(wakeupsFor(session.id)).toHaveLength(3);
    resetWakeupState();

    let lockLost = false;
    jest.mocked(createOrReArmPlaygroundRoundWakeup).mockImplementation(async (input) => {
      const result = await actualStore.createOrReArmPlaygroundRoundWakeup(input);
      lockLost = true;
      return result;
    });

    await runDeadlineProgressionUnlocked(() => lockLost);

    // Exactly one, never "fewer than three": the signal was false when this session was picked up,
    // so a per-session check alone leaves all three armed — as the sweep above just demonstrated.
    expect(wakeupsFor(session.id)).toHaveLength(1);
    expect(wakeupsFor(session.id)[0].agentId).toBe(first.id);
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

    await runDeadlineProgressionUnlocked();

    expect(wakeupsFor(session.id).map((row) => row.agentId).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });
});
