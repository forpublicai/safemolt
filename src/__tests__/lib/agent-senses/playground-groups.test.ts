/**
 * P4.1 parity: the pins M9 C8 established in agent-opportunities.test.ts must survive the
 * promotion into agent-senses. Membership from canonical group_members (not the legacy member_ids
 * snapshot), per-round action awareness, joined-lobby flagging, suggestion capping, and an
 * empty-but-flagged snapshot when a read throws.
 */

jest.mock("@/lib/store", () => ({
  listPlaygroundSessions: jest.fn(),
  getPlaygroundActions: jest.fn(),
  getPlaygroundSession: jest.fn(),
  listGroups: jest.fn(),
  isGroupMember: jest.fn(),
  getGroupMemberCount: jest.fn(),
}));

jest.mock("@/lib/playground/games", () => ({
  listGames: jest.fn(() => [{ id: "game-1", name: "Negotiation" }]),
}));

import { gatherPlayground } from "@/lib/agent-senses/playground";
import { gatherGroups } from "@/lib/agent-senses/groups";
import {
  getGroupMemberCount,
  getPlaygroundActions,
  getPlaygroundSession,
  isGroupMember,
  listGroups,
  listPlaygroundSessions,
} from "@/lib/store";

const mockedListSessions = jest.mocked(listPlaygroundSessions);
const mockedGetActions = jest.mocked(getPlaygroundActions);
const mockedGetSession = jest.mocked(getPlaygroundSession);
const mockedListGroups = jest.mocked(listGroups);
const mockedIsGroupMember = jest.mocked(isGroupMember);
const mockedMemberCount = jest.mocked(getGroupMemberCount);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("gatherPlayground", () => {
  function stubSessions(): void {
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
  }

  it("flags joined lobbies and per-round action state for participants", async () => {
    stubSessions();
    mockedGetActions.mockResolvedValue([{ agentId: "me" }] as never);

    const section = await gatherPlayground("me");

    expect(section.degraded).toBe(false);
    expect(section.items).toEqual([
      expect.objectContaining({ kind: "pending", id: "p1", joined: true, gameName: "Negotiation" }),
      expect.objectContaining({ kind: "pending", id: "p2", joined: false }),
      // Only the session where "me" participates is surfaced; action state comes from the
      // round's submitted actions.
      expect.objectContaining({
        kind: "active",
        id: "a1",
        awaitingPrompt: true,
        hasActedThisRound: true,
        currentRoundPrompt: "Round 2 prompt",
      }),
    ]);
    expect(mockedGetActions).toHaveBeenCalledWith("a1", 2);
    expect(mockedGetActions).toHaveBeenCalledTimes(1);
  });

  it("defaults minPlayers to 2 when the deploy does not know the game", async () => {
    stubSessions();
    mockedGetActions.mockResolvedValue([] as never);
    const section = await gatherPlayground("me");
    expect(section.items[0]).toEqual(expect.objectContaining({ minPlayers: 2, playerCount: 1 }));
  });

  it("returns an empty flagged snapshot when the store throws", async () => {
    mockedListSessions.mockRejectedValue(new Error("boom"));
    await expect(gatherPlayground("me")).resolves.toEqual({ items: [], degraded: true });
  });

  it("narrows to one session with a transcript tail under a playground_round focus", async () => {
    mockedGetSession.mockResolvedValue({
      id: "a1",
      gameId: "game-1",
      currentRound: 4,
      currentRoundPrompt: "Round 4 prompt",
      participants: [{ agentId: "me", status: "active" }],
      transcript: [
        { round: 1, gmPrompt: "p1", gmResolution: "r1", actions: [], resolvedAt: "t" },
        { round: 2, gmPrompt: "p2", gmResolution: "r2", actions: [], resolvedAt: "t" },
        { round: 3, gmPrompt: "p3", gmResolution: "r3", actions: [], resolvedAt: "t" },
        { round: 4, gmPrompt: "p4", gmResolution: "r4", actions: [], resolvedAt: "t" },
      ],
    } as never);
    mockedGetActions.mockResolvedValue([] as never);

    const section = await gatherPlayground("me", { focusSessionId: "a1" });

    expect(mockedListSessions).not.toHaveBeenCalled();
    expect(section.items).toHaveLength(1);
    expect(section.items[0]).toEqual(
      expect.objectContaining({ kind: "active", id: "a1", hasActedThisRound: false })
    );
    // Last three rounds only.
    expect(section.items[0]).toHaveProperty("transcriptTail", [
      { round: 2, gmPrompt: "p2", gmResolution: "r2" },
      { round: 3, gmPrompt: "p3", gmResolution: "r3" },
      { round: 4, gmPrompt: "p4", gmResolution: "r4" },
    ]);
  });

  it("answers empty (not degraded) when the focused session is gone or the agent left it", async () => {
    mockedGetSession.mockResolvedValueOnce(null as never);
    await expect(gatherPlayground("me", { focusSessionId: "gone" })).resolves.toEqual({
      items: [],
      degraded: false,
    });

    mockedGetSession.mockResolvedValueOnce({
      id: "a1",
      gameId: "game-1",
      currentRound: 1,
      participants: [{ agentId: "me", status: "forfeited" }],
      transcript: [],
    } as never);
    await expect(gatherPlayground("me", { focusSessionId: "a1" })).resolves.toEqual({
      items: [],
      degraded: false,
    });
  });
});

describe("gatherGroups", () => {
  it("derives membership from isGroupMember, not the legacy member_ids snapshot", async () => {
    mockedListGroups.mockResolvedValue([
      // member_ids says "not a member", canonical group_members says member — the canonical
      // source must win (joinGroup never maintains member_ids).
      { id: "general", name: "general", displayName: "General", memberIds: [] },
      { id: "labs", name: "labs", displayName: "Labs", memberIds: ["me"] },
    ] as never);
    mockedIsGroupMember.mockImplementation(async (_agentId: string, groupId: string) => groupId === "general");
    mockedMemberCount.mockResolvedValue(7 as never);

    const section = await gatherGroups("me", { schoolId: "foundation", suggestedLimit: 5 });

    expect(section.degraded).toBe(false);
    expect(section.items).toEqual([
      expect.objectContaining({ kind: "joined", id: "general" }),
      expect.objectContaining({ kind: "suggested", id: "labs", memberCount: 7 }),
    ]);
    // Counts are for suggestions only — a joined group never pays for one.
    expect(section.items[0].memberCount).toBeUndefined();
    expect(mockedMemberCount).toHaveBeenCalledTimes(1);
    expect(mockedMemberCount).toHaveBeenCalledWith("labs");
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
    mockedMemberCount.mockResolvedValue(1 as never);

    const section = await gatherGroups("me", { suggestedLimit: 3 });
    expect(section.items).toHaveLength(3);
  });

  it("falls back to the member_ids length when the canonical count read fails", async () => {
    mockedListGroups.mockResolvedValue([
      { id: "labs", name: "labs", displayName: "Labs", memberIds: ["a", "b"] },
    ] as never);
    mockedIsGroupMember.mockResolvedValue(false as never);
    mockedMemberCount.mockRejectedValue(new Error("count down"));

    const section = await gatherGroups("me");
    expect(section.items[0]).toEqual(expect.objectContaining({ memberCount: 2 }));
  });

  it("treats one failed membership probe as 'not a member' without degrading the section", async () => {
    mockedListGroups.mockResolvedValue([
      { id: "general", name: "general", displayName: "General", memberIds: [] },
    ] as never);
    mockedIsGroupMember.mockRejectedValue(new Error("probe down"));
    mockedMemberCount.mockResolvedValue(3 as never);

    const section = await gatherGroups("me");
    expect(section.degraded).toBe(false);
    expect(section.items).toEqual([expect.objectContaining({ kind: "suggested", id: "general" })]);
  });

  it("returns an empty flagged snapshot when listGroups throws", async () => {
    mockedListGroups.mockRejectedValue(new Error("boom"));
    await expect(gatherGroups("me")).resolves.toEqual({ items: [], degraded: true });
  });
});
