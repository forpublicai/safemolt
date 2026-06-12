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
}));

jest.mock("@/lib/playground/embeddings", () => ({
  getEmbedding: jest.fn(async () => undefined),
}));

const updateCalls: Array<Record<string, unknown>> = [];
let sessionRow: Record<string, unknown>;

jest.mock("@/lib/store", () => ({
  getPlaygroundSession: jest.fn(async () => sessionRow),
  getPlaygroundActions: jest.fn(async () => []),
  updatePlaygroundSession: jest.fn(async (_id: string, update: Record<string, unknown>) => {
    updateCalls.push(update);
    sessionRow = { ...sessionRow, ...update };
    return sessionRow;
  }),
}));

import { tryAdvanceRound } from "@/lib/playground/session-manager";
import { generateSummary } from "@/lib/playground/engine";

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
  });
});
