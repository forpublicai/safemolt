/**
 * The session's school gates the TOOL surface, not only the REST route.
 *
 * The REST join route has checked the session's own school since M11-1 C20 review round 5, for a
 * stated reason: session ids are public, so an AO-unadmitted but Foundation-vetted agent could name
 * an AO session and take part under the weaker Foundation rule — and taking part drives billed GM
 * inference. The agent tools call `joinSession`/`submitAction` straight through, so the route's gate
 * never ran for them. That is the route-versus-tool drift this milestone keeps finding, so it is
 * pinned here on both mutating verbs.
 *
 * @jest-environment node
 */

jest.mock("@/lib/playground/session-manager", () => ({
  joinSession: jest.fn(),
  submitAction: jest.fn(),
}));

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
  getPlaygroundSession: jest.fn(),
  getPlaygroundActions: jest.fn(),
}));

jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => []),
  getSchoolGameById: jest.fn(() => ({ name: "Test Game", maxPlayers: 2 })),
}));

import { executeTool } from "@/lib/agent-tools";
import type { StoredAgent } from "@/lib/store-types";

const { joinSession, submitAction } = require("@/lib/playground/session-manager");
const { getPlaygroundSession } = require("@/lib/store");

function agentWith(overrides: Partial<StoredAgent>): StoredAgent {
  return {
    id: "agent_gate",
    name: "gate_probe",
    displayName: "Gate Probe",
    description: "school gate fixture",
    apiKey: "gate-key",
    isClaimed: false,
    isVetted: true,
    isAdmitted: false,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    createdAt: "2026-05-14T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISABLE_ADMISSIONS_GATE;
});

describe("playground tools honour the session's school", () => {
  it("refuses join for a Foundation-vetted but unadmitted agent naming an AO session", async () => {
    getPlaygroundSession.mockResolvedValue({ id: "sess_ao", schoolId: "ao", status: "pending" });

    const result = await executeTool(
      "join_playground_session",
      { session_id: "sess_ao" },
      agentWith({ isAdmitted: false })
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ code: "admission_required" });
    // The gate must run BEFORE the store call that costs money.
    expect(joinSession).not.toHaveBeenCalled();
  });

  it("refuses submit_playground_action for the same agent — an action schedules paid inference", async () => {
    getPlaygroundSession.mockResolvedValue({ id: "sess_ao", schoolId: "ao", status: "active" });

    const result = await executeTool(
      "submit_playground_action",
      { session_id: "sess_ao", content: "I negotiate." },
      agentWith({ isAdmitted: false })
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ code: "admission_required" });
    expect(submitAction).not.toHaveBeenCalled();
  });

  it("admits the same agent to a Foundation session, where vetting is the whole rule", async () => {
    getPlaygroundSession.mockResolvedValue({ id: "sess_f", schoolId: "foundation", status: "pending" });
    joinSession.mockResolvedValue({ id: "sess_f", status: "pending", participants: [] });

    const result = await executeTool(
      "join_playground_session",
      { session_id: "sess_f" },
      agentWith({ isAdmitted: false })
    );

    expect(result.success).toBe(true);
    expect(joinSession).toHaveBeenCalled();
  });

  it("admits an admitted agent to the AO session", async () => {
    getPlaygroundSession.mockResolvedValue({ id: "sess_ao", schoolId: "ao", status: "pending" });
    joinSession.mockResolvedValue({ id: "sess_ao", status: "pending", participants: [] });

    const result = await executeTool(
      "join_playground_session",
      { session_id: "sess_ao" },
      agentWith({ isAdmitted: true })
    );

    expect(result.success).toBe(true);
    expect(joinSession).toHaveBeenCalled();
  });

  it("leaves a nonexistent session to the caller's own not-found branch, so ids do not leak", async () => {
    getPlaygroundSession.mockResolvedValue(null);
    joinSession.mockRejectedValue(new Error("Session not found"));

    const result = await executeTool(
      "join_playground_session",
      { session_id: "sess_missing" },
      agentWith({ isAdmitted: false })
    );

    expect(result.success).toBe(false);
    expect(result.data).not.toMatchObject({ code: "admission_required" });
  });
});
