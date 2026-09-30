/**
 * @jest-environment node
 *
 * M11-1 C23, memory mode: session creation and joining are check-then-act no more. The db-side
 * constraint races and the migration repair run in
 * `src/__tests__/integration/c23-admission-races.test.ts`.
 */

jest.mock("@/lib/memory/platform-ingest", () => ({
  schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/engine", () => ({
  generateRoundPrompt: jest.fn(async () => "round 1 prompt"),
  resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
  generateSummary: jest.fn(async () => "summary"),
}));

jest.mock("@/lib/playground/games", () => ({
  pickRandomGame: jest.fn(() => ({
    id: "c23-game",
    name: "C23 Game",
    minPlayers: 2,
    maxPlayers: 3,
    defaultMaxRounds: 3,
    premise: "",
    rules: "",
    scenes: [],
  })),
  getSchoolGameById: jest.fn(() => ({
    id: "c23-game",
    name: "C23 Game",
    minPlayers: 2,
    maxPlayers: 3,
    defaultMaxRounds: 3,
    premise: "",
    rules: "",
    scenes: [],
  })),
  listSchoolGameDefs: jest.fn(() => []),
  listGames: jest.fn(() => []),
}));

import { createPendingSession, joinSession } from "@/lib/playground/session-manager";
import { joinPlaygroundSession, listPlaygroundSessions, getPlaygroundSession } from "@/lib/store";
import { agents, apiKeyToAgentId } from "@/lib/store/_memory-state";
import { generateRoundPrompt } from "@/lib/playground/engine";

let seq = 0;

function seedAgent(id: string): void {
  agents.set(id, {
    id,
    name: id,
    description: "",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
    isVetted: true,
  });
  apiKeyToAgentId.set(`key_${id}`, id);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("session creation (C23)", () => {
  it("concurrent triggers for one school create exactly one live session; losers receive the winner's", async () => {
    const school = `c23_school_${seq++}`;
    const results = await Promise.all([
      createPendingSession(undefined, school),
      createPendingSession(undefined, school),
      createPendingSession(undefined, school),
    ]);

    const live = await listPlaygroundSessions({ status: "pending", schoolId: school, limit: 100 });
    expect(live).toHaveLength(1);
    // Every caller got a session, and it is the same one.
    expect(new Set(results.map((s) => s.id)).size).toBe(1);
  });

  it("concurrent triggers for different schools both succeed", async () => {
    const [a, b] = await Promise.all([
      createPendingSession(undefined, `c23_school_a_${seq}`),
      createPendingSession(undefined, `c23_school_b_${seq++}`),
    ]);
    expect(a.id).not.toBe(b.id);
  });
});

describe("joining (C23)", () => {
  it("the same agent joining twice concurrently occupies exactly one seat", async () => {
    const school = `c23_school_${seq++}`;
    const session = await createPendingSession(undefined, school);
    seedAgent("c23_joiner");

    await Promise.all([
      joinPlaygroundSession(session.id, { agentId: "c23_joiner", agentName: "c23_joiner", status: "active" }, 3),
      joinPlaygroundSession(session.id, { agentId: "c23_joiner", agentName: "c23_joiner", status: "active" }, 3),
    ]);

    const after = await getPlaygroundSession(session.id);
    expect(after?.participants).toHaveLength(1);
    expect(after?.participants[0].agentId).toBe("c23_joiner");
  });

  it("two different agents joining concurrently both persist; capacity refuses a fourth", async () => {
    const school = `c23_school_${seq++}`;
    const session = await createPendingSession(undefined, school);
    for (const id of ["c23_a", "c23_b", "c23_c", "c23_d"]) seedAgent(id);

    const results = await Promise.all(
      ["c23_a", "c23_b"].map((agentId) =>
        joinPlaygroundSession(session.id, { agentId, agentName: agentId, status: "active" }, 3)
      )
    );
    expect(results.every((r) => r.success)).toBe(true);
    expect((await getPlaygroundSession(session.id))?.participants.map((p) => p.agentId).sort()).toEqual([
      "c23_a",
      "c23_b",
    ]);

    await joinPlaygroundSession(session.id, { agentId: "c23_c", agentName: "c23_c", status: "active" }, 3);
    const full = await joinPlaygroundSession(session.id, { agentId: "c23_d", agentName: "c23_d", status: "active" }, 3);
    expect(full.success).toBe(false);
    expect(full.reason).toBe("Session full");
  });

  it("auto-start fires once under concurrent threshold joins — one prompt generation, not two", async () => {
    const school = `c23_school_${seq++}`;
    const session = await createPendingSession(undefined, school);
    seedAgent("c23_p1");
    seedAgent("c23_p2");

    // minPlayers is 2: both joins can observe the threshold, but the pending→active CAS admits
    // exactly one activation, so round-1 prompt generation (the GM spend) happens once.
    await Promise.all([joinSession(session.id, "c23_p1"), joinSession(session.id, "c23_p2")]);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let safeWaitUntil settle

    const after = await getPlaygroundSession(session.id);
    expect(after?.status).toBe("active");
    expect(jest.mocked(generateRoundPrompt)).toHaveBeenCalledTimes(1);
  });
});
