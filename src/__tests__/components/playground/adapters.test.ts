import {
  clientSessionFromStoreSession,
  normalizeGameDef,
  normalizeGameDefs,
  normalizePlaygroundSession,
  normalizePlaygroundSessions,
} from "@/components/playground/adapters";

describe("playground adapters", () => {
  it("normalizes snake_case game payloads", () => {
    expect(
      normalizeGameDef({
        id: "trade-bazaar",
        name: "Trade Bazaar",
        description: "A trading game.",
        min_players: 2,
        max_players: 5,
        default_max_rounds: 4,
      })
    ).toEqual({
      id: "trade-bazaar",
      name: "Trade Bazaar",
      description: "A trading game.",
      minPlayers: 2,
      maxPlayers: 5,
      defaultMaxRounds: 4,
    });
  });

  it("floors game numeric fields at one", () => {
    expect(
      normalizeGameDef({
        id: "trade-bazaar",
        name: "Trade Bazaar",
        min_players: 0,
        max_players: 0,
        default_max_rounds: 0,
      })
    ).toMatchObject({
      minPlayers: 1,
      maxPlayers: 1,
      defaultMaxRounds: 1,
    });
  });

  it("filters invalid entries from normalized arrays", () => {
    expect(
      normalizeGameDefs([
        null,
        { id: "trade-bazaar", name: "Trade Bazaar", min_players: 2, max_players: 5, default_max_rounds: 4 },
      ])
    ).toHaveLength(1);
    expect(
      normalizePlaygroundSessions([
        { id: "legacy", game_id: "trade-bazaar", status: "cancelled" },
        {
          id: "pg-1",
          game_id: "trade-bazaar",
          status: "active",
          current_round: 1,
          max_rounds: 4,
          created_at: "2026-05-06T00:00:00.000Z",
        },
      ])
    ).toHaveLength(1);
  });

  it("returns null for non-object payloads", () => {
    expect(normalizeGameDef(null)).toBeNull();
    expect(normalizeGameDef([])).toBeNull();
    expect(normalizePlaygroundSession(42)).toBeNull();
    expect(normalizePlaygroundSession([])).toBeNull();
  });

  it("filters unsupported session statuses and fills safe defaults", () => {
    expect(normalizePlaygroundSession({ id: "legacy", game_id: "trade-bazaar", status: "cancelled" })).toBeNull();

    expect(
      normalizePlaygroundSession({
        id: "pg-1",
        game_id: "trade-bazaar",
        status: "active",
        current_round: 2,
        max_rounds: 0,
        created_at: "2026-05-06T00:00:00.000Z",
      })
    ).toMatchObject({
      id: "pg-1",
      gameId: "trade-bazaar",
      status: "active",
      currentRound: 2,
      maxRounds: 1,
      participants: [],
      transcript: [],
      createdAt: "2026-05-06T00:00:00.000Z",
    });
  });

  it("rejects payloads that are not canonical snake_case (M9/C13)", () => {
    // The playground APIs emit one canonical shape; the old camelCase
    // fallbacks are gone, so a camel-only payload no longer parses.
    expect(
      normalizePlaygroundSession({
        id: "pg-2",
        gameId: "trade-bazaar",
        status: "completed",
        currentRound: 4,
        maxRounds: 4,
        createdAt: "2026-05-06T00:00:00.000Z",
      })
    ).toBeNull();
  });

  it("projects in-process store sessions to the client shape", () => {
    expect(
      clientSessionFromStoreSession({
        id: "pg-2",
        gameId: "trade-bazaar",
        status: "completed",
        participants: [{ agentId: "agent-1", agentName: "Arlo", status: "active" }],
        transcript: [],
        currentRound: 4,
        maxRounds: 4,
        createdAt: "2026-05-06T00:00:00.000Z",
        completedAt: "2026-05-06T00:10:00.000Z",
      } as never)
    ).toMatchObject({
      id: "pg-2",
      gameId: "trade-bazaar",
      status: "completed",
      currentRound: 4,
      maxRounds: 4,
      completedAt: "2026-05-06T00:10:00.000Z",
    });
  });
});
