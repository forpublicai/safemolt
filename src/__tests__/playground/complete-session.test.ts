/**
 * @jest-environment node
 *
 * M9 C10: forfeited and normal completions must run identical cleanup — one
 * terminal update with status=completed, the final round in the transcript,
 * a summary generated from that same transcript, and prompt/deadline cleared.
 */

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "next prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async (session: { transcript: unknown[] }) => `summary of ${session.transcript.length} rounds`),
}));

jest.mock("@/lib/playground/games", () => ({
  pickRandomGame: jest.fn(),
  getSchoolGameById: jest.fn(() => ({
    id: "game-1",
    name: "Negotiation",
    minPlayers: 2,
    maxPlayers: 4,
    premise: "",
    rules: "",
    scenes: [],
  })),
  listSchoolGameDefs: jest.fn(() => []),
}));

jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/lifecycle", () => ({
  enforceSessionLifetimeCap: jest.fn(async () => ({ completed: 0 })),
  revalidatePlaygroundSeed: jest.fn(),
  safeWaitUntil: jest.fn(),
}));

jest.mock("@/lib/playground/memory", () => ({
  storeMemory: jest.fn(async () => ({})),
  // M11-1b D5 atomic follow-up: memories are only PREPARED outside the write; the terminal CAS
  // writes them, so this mock mints rows rather than persisting anything.
  prepareResolutionMemory: jest.fn((input: Record<string, unknown>) => ({
    ...input,
    id: "mem_test",
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
}));

jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

const updateCalls: Array<Record<string, unknown>> = [];
/** What each terminal write carried alongside the update (D5 atomic follow-up). */
const memoryPayloads: unknown[][] = [];
/**
 * The EVENTS each resolution write carried (M11-2 P3.2).
 *
 * `applyPlaygroundResolution` has accepted a 5th argument since u3d; only the completion branch used
 * to supply one. The advance branch now carries `playground.round_opened`, gated on the same CAS —
 * so both branches' payloads are recorded here and asserted separately.
 */
const eventPayloads: Array<ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>> = [];
let sessionRow: Record<string, unknown>;

jest.mock("@/lib/store", () => ({
  getPlaygroundSession: jest.fn(async () => sessionRow),
  getPlaygroundActions: jest.fn(async () => []),
  updatePlaygroundSession: jest.fn(async (_id: string, update: Record<string, unknown>) => {
    updateCalls.push(update);
    sessionRow = { ...sessionRow, ...update };
    return sessionRow;
  }),
  // M11-1 C12: resolution runs under a lease; the terminal write is the fenced apply. The mock
  // grants the claim and records the applied update exactly as the legacy update mock did, so
  // the terminal-cleanup assertions below keep observing the single terminal write.
  claimPlaygroundResolution: jest.fn(async (_id: string, _round: number, token: string) => {
    sessionRow = { ...sessionRow, resolveClaimToken: token };
    return true;
  }),
  renewPlaygroundResolutionClaim: jest.fn(async () => true),
  applyPlaygroundResolution: jest.fn(
    async (
      _id: string,
      _fence: { round: number; token: string },
      update: Record<string, unknown>,
      memories: unknown[] = [],
      events: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }> = []
    ) => {
      updateCalls.push(update);
      memoryPayloads.push(memories);
      eventPayloads.push(events);
      sessionRow = { ...sessionRow, ...update, resolveClaimToken: null, resolveClaimExpiresAt: null };
      return true;
    }
  ),
}));

import { tryAdvanceRound } from "@/lib/playground/session-manager";
import { generateSummary } from "@/lib/playground/engine";
import { schedulePlaygroundMemoryIngest } from "@/lib/memory/platform-ingest";

function baseSession(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "sess-1",
    gameId: "game-1",
    schoolId: "foundation",
    status: "active",
    currentRound: 1,
    maxRounds: 3,
    currentRoundPrompt: "round prompt",
    roundDeadline: new Date(Date.now() - 60_000).toISOString(), // deadline passed
    transcript: [],
    participants: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updateCalls.length = 0;
  memoryPayloads.length = 0;
  eventPayloads.length = 0;
  // Re-arm the store mocks: the loss gates below override these per test, and `clearAllMocks`
  // clears the implementation, not just the calls.
  const store = jest.requireMock("@/lib/store");
  store.getPlaygroundSession.mockImplementation(async () => sessionRow);
  store.getPlaygroundActions.mockResolvedValue([]);
  store.claimPlaygroundResolution.mockImplementation(async (_id: string, _round: number, token: string) => {
    sessionRow = { ...sessionRow, resolveClaimToken: token };
    return true;
  });
  store.renewPlaygroundResolutionClaim.mockResolvedValue(true);
  store.applyPlaygroundResolution.mockImplementation(
    async (
      _id: string,
      _fence: unknown,
      update: Record<string, unknown>,
      memories: unknown[] = [],
      events: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }> = []
    ) => {
      updateCalls.push(update);
      memoryPayloads.push(memories);
      eventPayloads.push(events);
      sessionRow = { ...sessionRow, ...update, resolveClaimToken: null, resolveClaimExpiresAt: null };
      return true;
    }
  );
});

function expectTerminalCleanup(update: Record<string, unknown>) {
  expect(update.status).toBe("completed");
  expect(update.currentRoundPrompt).toBeNull();
  expect(update.roundDeadline).toBeNull();
  expect(update.completedAt).toEqual(expect.any(String));
  expect(update.summary).toEqual(expect.any(String));
}

describe("tryAdvanceRound terminal transitions", () => {
  it("runs the shared cleanup when everyone forfeits", async () => {
    sessionRow = baseSession({
      participants: [
        { agentId: "a1", agentName: "A1", status: "active", missedRounds: 1 },
        { agentId: "a2", agentName: "A2", status: "active", missedRounds: 1 },
      ],
    });

    await tryAdvanceRound("sess-1");

    expect(updateCalls).toHaveLength(1);
    const update = updateCalls[0];
    expectTerminalCleanup(update);
    const transcript = update.transcript as Array<{ gmResolution: string }>;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].gmResolution).toContain("forfeited");
    // Summary must be generated from the same transcript that is persisted
    // (the old forfeit branch summarized a transcript missing the final round).
    expect(jest.mocked(generateSummary)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript }),
      expect.anything()
    );
    expect(update.summary).toBe("summary of 1 rounds");
    // Nobody acted, so the forfeit branch carries no memories — and it must still be a WON write.
    expect(memoryPayloads[0]).toEqual([]);
    // M11-2 P3.2: completing a session does not OPEN a round. Pinned so a later change that hands
    // `round_opened` to every resolution write is visible rather than silent — a completion event
    // would give every participant a wakeup for a round that will never accept an action.
    expect(eventPayloads[0].map((event) => event.kind)).toEqual(["playground.session_completed"]);
  });

  it("runs the same cleanup on a normal max-rounds completion", async () => {
    sessionRow = baseSession({
      currentRound: 3,
      maxRounds: 3,
      participants: [
        { agentId: "a1", agentName: "A1", status: "active", missedRounds: 0 },
      ],
    });
    const { getPlaygroundActions } = jest.requireMock("@/lib/store");
    getPlaygroundActions.mockResolvedValue([
      { agentId: "a1", content: "my move", round: 3 },
    ]);

    await tryAdvanceRound("sess-1");

    expect(updateCalls).toHaveLength(1);
    const update = updateCalls[0];
    expectTerminalCleanup(update);
    const transcript = update.transcript as Array<{ gmResolution: string }>;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].gmResolution).toBe("GM narration");
    expect(jest.mocked(generateSummary)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript }),
      expect.anything()
    );

    // Field-for-field, the cleanup is identical to the forfeit path apart
    // from the transcript/participants payloads.
    expect(Object.keys(update).sort()).toEqual(
      ["completedAt", "currentRoundPrompt", "participants", "roundDeadline", "status", "summary", "transcript"].sort()
    );

    // D5 atomic follow-up: the round's memory travels WITH the terminal write, in the same call.
    // Before it, this was a separate statement that could be split from the advance.
    expect(memoryPayloads[0]).toEqual([
      expect.objectContaining({ agentId: "a1", sessionId: "sess-1", roundCreated: 3 }),
    ]);
    // The same pin as the forfeit branch: a completion opens no round.
    expect(eventPayloads[0].map((event) => event.kind)).toEqual(["playground.session_completed"]);
  });
});

/**
 * M11-2 P3.2 — rounds >= 2 open through the resolution CAS, and the event rides it.
 *
 * `applyPlaygroundResolution` has carried a 5th `events` argument since u3d and already gates it on
 * the same `advanced` CTE that carries round, prompt, deadline, transcript and participants — so the
 * loser of an advance race writes nothing and emits nothing for free. That gating is a property of
 * the statement (asserted against Postgres in the integration suite); what belongs here is that the
 * advance branch supplies the event at all, with the NEW round's number.
 */
describe("advanceToNextRound opens the next round", () => {
  it("hands the CAS exactly one round_opened naming the NEW round", async () => {
    sessionRow = baseSession({
      currentRound: 1,
      maxRounds: 3,
      participants: [{ agentId: "a1", agentName: "A1", status: "active", missedRounds: 0 }],
    });
    const { getPlaygroundActions } = jest.requireMock("@/lib/store");
    getPlaygroundActions.mockResolvedValue([{ agentId: "a1", content: "my move", round: 1 }]);

    await tryAdvanceRound("sess-1");

    expect(updateCalls).toHaveLength(1);
    const update = updateCalls[0];
    // The prompt and the event are the SAME write: that is what makes a promptless round unopenable.
    expect(update.currentRound).toBe(2);
    expect(update.currentRoundPrompt).toBe("next prompt");
    expect(update.status).toBeUndefined();

    expect(eventPayloads[0]).toHaveLength(1);
    expect(eventPayloads[0][0].kind).toBe("playground.round_opened");
    // The NEW round, never the one just resolved — a wakeup keyed on the resolved round would be
    // rejected as a duplicate by `submitAction` and would spend a budget claim for nothing.
    expect(eventPayloads[0][0].payload).toEqual({ session_id: "sess-1", round: 2 });
  });
});

/**
 * The D5 atomic follow-up moved every derived write behind the terminal CAS. These gates hold that
 * ordering in place: a resolver that has lost its claim must buy nothing further and schedule
 * nothing external, in both the resolved and the all-forfeited branch.
 */
describe("a resolver that has lost its claim", () => {
  const store = () => jest.requireMock("@/lib/store");
  const oneActive = () => baseSession({
    currentRound: 3,
    maxRounds: 3,
    participants: [{ agentId: "a1", agentName: "A1", status: "active", missedRounds: 0 }],
  });

  it("buys no second inference call when the advisory renewal refuses", async () => {
    sessionRow = oneActive();
    store().getPlaygroundActions.mockResolvedValue([{ agentId: "a1", content: "my move", round: 3 }]);
    store().renewPlaygroundResolutionClaim.mockResolvedValue(false);

    await tryAdvanceRound("sess-1");

    // The GM resolution was already bought before the claim could be re-checked; the SUMMARY was
    // not, and no terminal write was attempted.
    expect(jest.mocked(generateSummary)).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(jest.mocked(schedulePlaygroundMemoryIngest)).not.toHaveBeenCalled();
  });

  it("schedules no vector ingest when the terminal CAS refuses", async () => {
    sessionRow = oneActive();
    store().getPlaygroundActions.mockResolvedValue([{ agentId: "a1", content: "my move", round: 3 }]);
    store().applyPlaygroundResolution.mockResolvedValue(false);

    await tryAdvanceRound("sess-1");

    // The CAS wrote neither the advance nor the memories, so nothing external may follow it.
    expect(jest.mocked(schedulePlaygroundMemoryIngest)).not.toHaveBeenCalled();
  });

  it("schedules no vector ingest when the all-forfeited CAS refuses", async () => {
    sessionRow = baseSession({
      participants: [
        { agentId: "a1", agentName: "A1", status: "active", missedRounds: 1 },
        { agentId: "a2", agentName: "A2", status: "active", missedRounds: 1 },
      ],
    });
    store().applyPlaygroundResolution.mockResolvedValue(false);

    await tryAdvanceRound("sess-1");

    // This branch used to schedule ingest BEFORE the write, so a lapsed resolver pushed vectors
    // for a round it never resolved.
    expect(jest.mocked(schedulePlaygroundMemoryIngest)).not.toHaveBeenCalled();
  });
});
