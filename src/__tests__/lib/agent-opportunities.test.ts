/**
 * M9 C8: the canonical agent-opportunity layer both the loop and /home
 * project from. Pins the semantics that had previously drifted between the
 * two surfaces: membership from canonical group_members (not the legacy
 * member_ids snapshot), and per-round action awareness for active sessions.
 */

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
  getPlaygroundActions: jest.fn(),
  listGroups: jest.fn(),
  isGroupMember: jest.fn(),
}));

jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => [{ id: "game-1", name: "Negotiation" }]),
}));

import {
  gatherGroupOpportunities,
  gatherPlaygroundOpportunities,
} from "@/lib/agent-opportunities";
import {
  getPlaygroundActions,
  isGroupMember,
  listGroups,
  listPlaygroundSessions,
} from "@/lib/store";

const mockedListSessions = jest.mocked(listPlaygroundSessions);
const mockedGetActions = jest.mocked(getPlaygroundActions);
const mockedListGroups = jest.mocked(listGroups);
const mockedIsGroupMember = jest.mocked(isGroupMember);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gatherPlaygroundOpportunities", () => {
  it("flags joined lobbies and per-round action state for participants", async () => {
    mockedListSessions.mockImplementation(async (opts?: { status?: string }) => {
      if (opts?.status === "pending") {
        return [
          { id: "p1", gameId: "game-1", participants: [{ agentId: "me", status: "active" }] },
          { id: "p2", gameId: "game-1", participants: [{ agentId: "other", status: "active" }] },
        ] as never;
      }
      return [
        {
          id: "a1",
          gameId: "game-1",
          currentRound: 2,
          currentRoundPrompt: "Round 2 prompt",
          participants: [{ agentId: "me", status: "active" }],
        },
        {
          id: "a2",
          gameId: "game-1",
          currentRound: 1,
          currentRoundPrompt: "Round 1 prompt",
          participants: [{ agentId: "other", status: "active" }],
        },
      ] as never;
    });
    mockedGetActions.mockResolvedValue([{ agentId: "me" }] as never);

    const result = await gatherPlaygroundOpportunities("me");

    expect(result.pending).toEqual([
      expect.objectContaining({ id: "p1", joined: true, gameName: "Negotiation" }),
      expect.objectContaining({ id: "p2", joined: false }),
    ]);
    // Only the session where "me" participates is surfaced; action state comes
    // from the round's submitted actions.
    expect(result.active).toEqual([
      expect.objectContaining({
        id: "a1",
        awaitingPrompt: true,
        hasActedThisRound: true,
        currentRoundPrompt: "Round 2 prompt",
      }),
    ]);
    expect(mockedGetActions).toHaveBeenCalledWith("a1", 2);
    expect(mockedGetActions).toHaveBeenCalledTimes(1);
  });

  it("returns an empty snapshot when the store throws", async () => {
    mockedListSessions.mockRejectedValue(new Error("boom"));
    await expect(gatherPlaygroundOpportunities("me")).resolves.toEqual({
      pending: [],
      active: [],
    });
  });
});

describe("gatherGroupOpportunities", () => {
  it("derives membership from isGroupMember, not the legacy member_ids snapshot", async () => {
    mockedListGroups.mockResolvedValue([
      // member_ids says "not a member", canonical group_members says member —
      // the canonical source must win (joinGroup never maintains member_ids).
      { id: "general", name: "general", displayName: "General", memberIds: [] },
      { id: "labs", name: "labs", displayName: "Labs", memberIds: ["me"] },
    ] as never);
    mockedIsGroupMember.mockImplementation(async (_agentId: string, groupId: string) => groupId === "general");

    const result = await gatherGroupOpportunities("me", { schoolId: "foundation", suggestedLimit: 5 });

    expect(result.joined.map((g) => g.id)).toEqual(["general"]);
    expect(result.suggested.map((g) => g.id)).toEqual(["labs"]);
  });

  it("caps suggestions at suggestedLimit", async () => {
    mockedListGroups.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        id: `g${i}`,
        name: `g${i}`,
        displayName: `G${i}`,
        memberIds: [],
      })) as never
    );
    mockedIsGroupMember.mockResolvedValue(false as never);

    const result = await gatherGroupOpportunities("me", { suggestedLimit: 3 });
    expect(result.suggested).toHaveLength(3);
  });
});
