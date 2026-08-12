/**
 * @jest-environment node
 */

// M11-2 P1.4: the join tool is an adapter over the ACTION, which owns the school gate and the
// events before delegating to the session manager. `already_joined` is still the tool's own
// derivation from a live read, which is why the store mock stays.
jest.mock("@/lib/actions/playground", () => ({
  joinSession: jest.fn(),
}));

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
  getPlaygroundSession: jest.fn(),
  getPlaygroundActions: jest.fn(),
  createPlaygroundAction: jest.fn(),
}));

jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => []),
  getSchoolGameById: jest.fn(() => ({ name: "Test Game", maxPlayers: 2 })),
}));

jest.mock("@/lib/playground/prefabs", () => ({
  getRandomPrefab: jest.fn(() => ({ id: "the_diplomat" })),
}));

import { executeTool } from "@/lib/agent-tools";
import type { StoredAgent } from "@/lib/store-types";

const { joinSession } = require("@/lib/actions/playground");
const { listPlaygroundSessions, getPlaygroundSession } = require("@/lib/store");

const agent: StoredAgent = {
  id: "agent_1",
  name: "arlo_sketches",
  displayName: "Arlo",
  description: "test agent",
  apiKey: "test-key",
  isClaimed: false,
  isVetted: true,
  isAdmitted: false,
  points: 0,
  votePoints: 0,
  evaluationPoints: 0,
  legacyUnattributedPoints: 0,
  followerCount: 0,
  createdAt: "2026-05-14T00:00:00.000Z",
};

describe("playground agent tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("joins through the session manager so activation semantics stay shared with REST", async () => {
    joinSession.mockResolvedValue({
      ok: true,
      data: {
        session: {
          id: "pg_1",
          gameId: "tennis",
          status: "active",
          currentRound: 1,
          participants: [
            { agentId: "agent_existing", agentName: "Existing", status: "active" },
            { agentId: "agent_1", agentName: "Arlo", status: "active" },
          ],
        },
      },
    });

    const result = await executeTool("join_playground_session", { session_id: "pg_1" }, agent);

    expect(joinSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "pg_1", agent: expect.objectContaining({ id: "agent_1" }) })
    );
    expect(listPlaygroundSessions).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: {
        session_id: "pg_1",
        joined: true,
        already_joined: false,
        status: "active",
        participants: 2,
      },
    });
  });

  it("treats duplicate joins to an already-active session as a successful idempotent response", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    joinSession.mockResolvedValue({
      ok: false,
      code: "bad_request",
      message: "Session is not in pending state",
    });
    getPlaygroundSession.mockResolvedValue({
      id: "pg_1",
      gameId: "tennis",
      status: "active",
      currentRound: 1,
      participants: [
        { agentId: "agent_existing", agentName: "Existing", status: "active" },
        { agentId: "agent_1", agentName: "Arlo", status: "active" },
      ],
    });

    const result = await executeTool("join_playground_session", { session_id: "pg_1" }, agent);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      data: {
        session_id: "pg_1",
        joined: true,
        already_joined: true,
        status: "active",
        participants: 2,
      },
    });
    consoleSpy.mockRestore();
  });

  it("returns structured join guidance for full sessions without using the generic tool error path", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    joinSession.mockResolvedValue({ ok: false, code: "bad_request", message: "Session full" });
    getPlaygroundSession.mockResolvedValue({
      id: "pg_1",
      gameId: "tennis",
      status: "pending",
      currentRound: 0,
      participants: [
        { agentId: "agent_existing", agentName: "Existing", status: "active" },
        { agentId: "agent_other", agentName: "Other", status: "active" },
      ],
    });

    const result = await executeTool("join_playground_session", { session_id: "pg_1" }, agent);

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Session full",
      data: {
        code: "session_full",
        session_id: "pg_1",
        status: "pending",
        participants: 2,
      },
    });
    consoleSpy.mockRestore();
  });
});
